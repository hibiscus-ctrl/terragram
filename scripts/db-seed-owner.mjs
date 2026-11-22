// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Make an account an org ADMIN (and super-owner-ready) without wiping anything —
 * the standalone re-seed. Useful after a fresh sign-in (the app auto-provisions
 * you as `admin`) or any time you need to (re)assert admin access. Idempotent.
 *
 * Pass --install-id <n> (or set SEED_INSTALL_ID) to ALSO re-link the org to its
 * GitHub App installation — required for Option A (tokenless OIDC) reporting to
 * work; a wiped link is why reports 401 with "No active GitHub App installation".
 *
 * Usage (loads .env.local first via the db:seed-owner npm script):
 *   npm run db:seed-owner -- you@example.com
 *   npm run db:seed-owner -- you@example.com --install-id 140711073
 */
import { installId, ownerEmail, ownerSeedSql, projectRef, runSql } from "./supabase-query.mjs";

const args = process.argv.slice(2);
const flagValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const installArg = flagValue("--install-id");
// The positional arg is the email — anything that isn't a flag or a flag's value.
const emailArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--install-id");

const email = ownerEmail(emailArg);
const install = installId(installArg);

if (!email) {
  console.error(
    "No owner email. Pass one (npm run db:seed-owner -- you@example.com) or set SEED_OWNER_EMAIL / SUPER_OWNER_EMAILS.",
  );
  process.exit(1);
}

try {
  await runSql(ownerSeedSql(email, install));
  console.log(
    `OK (project ${projectRef()}). ${email} is an org admin${install ? `, App installation ${install} linked` : ""} (re-run safe).`,
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
