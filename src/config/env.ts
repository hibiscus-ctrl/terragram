// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What this deployment is configured to do — decided once, from the environment,
 * rather than discovered one failure at a time.
 *
 * **The failure this exists for is not a missing variable.** A missing REQUIRED
 * one already fails loudly: the Supabase client throws at first use and the
 * readiness probe 503s. The failure nothing watched was the HALF-configured
 * feature — a proxy URL with no signing secret, a GitHub client id with no
 * secret, Git hosts configured but no `GIT_TOKEN_ENCRYPTION_KEY` to seal their
 * tokens with. Each of those boots clean, serves every page, and then fails at the
 * one moment it is used.
 *
 * So features are declared as SETS, and a set with some but not all of its
 * variables is the finding. `src/instrumentation.ts` writes the report once at
 * boot; `/api/health/ready` serves it, so an operator can read it without shell
 * access to the container.
 *
 * Pure and free of `next/*` on purpose — the environment is a parameter, so the
 * decisions here are unit-testable without a booted server.
 */

/** A variable, and the name it may still go by. */
export type EnvVar = {
  name: string;
  /** Accepted in its place — a rename still in flight, never a second meaning. */
  alias?: string;
  /** Minimum length, where a shorter value is refused at runtime anyway. */
  minLength?: number;
};

export type Feature = {
  key: string;
  /** What turning this on gives you, and what its absence costs. */
  summary: string;
  /** The variables that make up the feature. Any of them set turns it on. */
  vars: readonly EnvVar[];
  /**
   * Variables the feature also needs but does not own — shared with another
   * feature, so their presence alone does not mean THIS feature was meant to be
   * on. Missing while `vars` are set is still `partial`.
   */
  needs?: readonly EnvVar[];
};

/** Without these the app cannot serve a request at all. */
export const REQUIRED: readonly EnvVar[] = [
  { name: "NEXT_PUBLIC_SUPABASE_URL" },
  { name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", alias: "NEXT_PUBLIC_SUPABASE_ANON_KEY" },
  { name: "SUPABASE_SECRET_KEY", alias: "SUPABASE_SERVICE_ROLE_KEY" },
  { name: "NEXT_PUBLIC_SITE_URL" },
];

const GIT_TOKEN_KEY: EnvVar = { name: "GIT_TOKEN_ENCRYPTION_KEY" };

/**
 * One entry per feature, listing every variable that feature needs TOGETHER. The
 * groups mirror `.env.local.example`'s sections: that file is what an operator
 * follows, and a differently-grouped list here would be one more thing to sync.
 */
export const FEATURES: readonly Feature[] = [
  {
    key: "billing",
    summary: "Stripe checkout, the customer portal and webhook-driven plan changes",
    vars: [{ name: "STRIPE_SECRET_KEY" }, { name: "STRIPE_WEBHOOK_SECRET" }],
  },
  {
    key: "email",
    summary: "invite emails through Amazon SES; without it an invite is a link the Admin copies and sends",
    vars: [{ name: "SES_ACCESS_KEY_ID" }, { name: "SES_SECRET_ACCESS_KEY" }],
  },
  {
    key: "managedModels",
    summary: "the EU model proxy; without it managed inference is off and the workspace runs deterministic",
    vars: [{ name: "TERRAGRAM_MODEL_PROXY_URL" }, { name: "TERRAGRAM_MODEL_PROXY_SECRET" }],
  },
  {
    key: "gitGithub",
    summary: "\"Open pull request\" on GitHub; tokens are sealed, so it needs the encryption key too",
    vars: [{ name: "GITHUB_APP_CLIENT_ID" }, { name: "GITHUB_APP_CLIENT_SECRET" }],
    needs: [GIT_TOKEN_KEY],
  },
  {
    key: "gitGitlab",
    summary: "\"Open pull request\" on GitLab; tokens are sealed, so it needs the encryption key too",
    vars: [{ name: "GITLAB_APP_ID" }, { name: "GITLAB_APP_SECRET" }],
    needs: [GIT_TOKEN_KEY],
  },
  {
    key: "jobsDrain",
    // 16 is not a policy invented here: `requireJobsSecret` refuses a shorter
    // secret at request time, answering 401 to its own cron while doing it.
    summary: "the scheduled job routes (the 15-minute usage flush); a secret under 16 chars disables them silently",
    vars: [{ name: "JOBS_DRAIN_SECRET", minLength: 16 }],
  },
  {
    key: "evidenceSigning",
    summary: "Ed25519 signatures on evidence receipts; without it a receipt reports unsigned",
    vars: [{ name: "EVIDENCE_SIGNING_KEY" }],
  },
];

type FeatureState = "on" | "off" | "partial";

export type EnvReport = {
  /** True when nothing REQUIRED is missing and no feature is half-configured. */
  ok: boolean;
  /** Required variables with no value. The app cannot serve. */
  missing: string[];
  /** Set variables shorter than the runtime accepts, as `NAME (min N)`. */
  weak: string[];
  /** Feature key → its state. `partial` is the one worth acting on. */
  features: Record<string, FeatureState>;
  /** For each `partial` feature, the variables it is still missing. */
  incomplete: Record<string, string[]>;
};

type Env = Record<string, string | undefined>;

/** Present means non-empty after trimming — `FOO=` in a dotenv file is not a value. */
function value(env: Env, v: EnvVar): string | undefined {
  const raw = env[v.name] ?? (v.alias ? env[v.alias] : undefined);
  return raw?.trim() || undefined;
}

function present(env: Env, v: EnvVar): boolean {
  return value(env, v) !== undefined;
}

/** Whether every variable a feature needs is set — `checkEnv`'s "on", for one feature. */
export function featureConfigured(key: string, env: Env = process.env): boolean {
  const feature = FEATURES.find((f) => f.key === key);
  if (!feature) return false;
  return [...feature.vars, ...(feature.needs ?? [])].every((v) => present(env, v));
}

/**
 * Report what this environment configures.
 *
 * `env` is a parameter rather than a read of `process.env` so a test can drive it
 * and so `instrumentation.ts` and the readiness probe describe the same snapshot.
 */
export function checkEnv(env: Env = process.env): EnvReport {
  const missing = REQUIRED.filter((v) => !present(env, v)).map((v) => v.name);
  const features: Record<string, FeatureState> = {};
  const incomplete: Record<string, string[]> = {};
  // Set but shorter than the runtime accepts: present, so the feature reads "on",
  // and refused at the one moment it is used, so it is still a finding.
  const weak = FEATURES.flatMap((f) => f.vars)
    .filter((v) => {
      const found = value(env, v);
      return found !== undefined && v.minLength !== undefined && found.length < v.minLength;
    })
    .map((v) => `${v.name} (min ${v.minLength})`);

  for (const feature of FEATURES) {
    const absent = feature.vars.filter((v) => !present(env, v)).map((v) => v.name);
    // All of its own variables absent is a deliberate "off", not a defect — most
    // deployments run with several of these unset.
    if (absent.length === feature.vars.length) {
      features[feature.key] = "off";
      continue;
    }
    const absentNeeds = (feature.needs ?? []).filter((v) => !present(env, v)).map((v) => v.name);
    const gaps = [...absent, ...absentNeeds];
    if (gaps.length === 0) {
      features[feature.key] = "on";
    } else {
      features[feature.key] = "partial";
      incomplete[feature.key] = gaps;
    }
  }

  return {
    ok: missing.length === 0 && weak.length === 0 && Object.keys(incomplete).length === 0,
    missing,
    weak,
    features,
    incomplete,
  };
}
