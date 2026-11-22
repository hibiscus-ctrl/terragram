# syntax=docker/dockerfile:1
# Multi-stage build for the Next.js 16 standalone server (Railway / any container host).
#
# Base image is digest-pinned (the :24-alpine tag is for humans, the @sha256 is the
# authoritative pin) for reproducible builds — a re-tagged upstream can't be
# substituted. Bump with: `docker buildx imagetools inspect node:24-alpine`.
#
# Node 24 is the floor declared in package.json `engines`, .nvmrc and CI — the
# production runtime must not be the one place the version story differs.

# 1. Install dependencies (cached unless lockfile changes) ----------------------
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS deps
WORKDIR /app
# libc compat for any native deps Next pulls in.
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json .npmrc ./
# The workspace manifests, so `npm ci` links packages/engine, packages/cli and action into
# node_modules (the lockfile lists all three; the app itself imports only the engine).
COPY packages/engine/package.json ./packages/engine/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY action/package.json ./action/package.json

# `@infraweaver-io/*` resolves to GitHub Packages (see .npmrc), which needs a
# read token even for a package published to the org — so this layer, unlike
# every other one, cannot run unauthenticated.
#
# TWO ways to supply it, in order of preference:
#
#   1. A BuildKit secret (nothing lands in the image, not even in history):
#        docker build --secret id=gh_packages_token,env=GH_PACKAGES_TOKEN .
#
#   2. A build ARG, for builders that cannot mount secrets — Railway passes
#      service variables to the Docker build as ARGs and does not expose
#      `--secret`. This WORKS, but the value is recoverable from image history,
#      so the token must be a fine-grained, `read:packages`-only, bot-account
#      token with an expiry. It is the reason the repo's standing rule ("keep
#      secrets out of build layers", below) has an exception here rather than
#      being quietly broken.
#
# Either way the credential is written and deleted inside ONE `RUN`, so it is not
# part of this layer's filesystem, and this stage contributes only `node_modules`
# to the final image. Mirrors infraweaver-ui, deliberately.
ARG GH_PACKAGES_TOKEN=""
RUN --mount=type=secret,id=gh_packages_token,required=false \
    set -eu; \
    TOKEN="$( [ -f /run/secrets/gh_packages_token ] && cat /run/secrets/gh_packages_token || printf '%s' "$GH_PACKAGES_TOKEN" )"; \
    if [ -z "$TOKEN" ]; then \
      echo "ERROR: no GitHub Packages token. Pass --secret id=gh_packages_token or --build-arg GH_PACKAGES_TOKEN=…" >&2; \
      echo "       @infraweaver-io/* cannot be installed without one." >&2; \
      exit 1; \
    fi; \
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$TOKEN" > /root/.npmrc; \
    npm ci; \
    rm -f /root/.npmrc

# 2. Build the app --------------------------------------------------------------
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so they
# must be present here. Railway passes service variables to the Docker build as
# build args automatically — declare each one we read on the client.
#
# Runtime SECRETS (SUPABASE_SECRET_KEY, STRIPE_SECRET_KEY, …) are deliberately NOT
# build args: the admin clients are lazily constructed (see src/libs/lazy-client.ts),
# so the build never reads them. They're injected at runtime by the host. Do not add
# them here — keep secrets out of build layers.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_TELEMETRY_DISABLED=1
# Railway-provided; next.config.js turns it into `deploymentId` (version-skew
# protection). Not a secret. Empty outside Railway, which leaves it off.
ARG RAILWAY_GIT_COMMIT_SHA

RUN npm run build

# 3. Minimal runtime image ------------------------------------------------------
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Run as an unprivileged user.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# The standalone output bundles only the server + its traced node_modules. The
# static assets and /public are not included, so copy them in alongside.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
