import { execFileSync } from "node:child_process";
import { defineConfig } from "cypress";

/**
 * E2E configuration. Run via `npm run e2e` / `npm run e2e:open` — both wrap
 * Cypress in `env-cmd -f ./.env.local`, so the seeding tasks and `baseUrl`
 * resolve against the same Supabase project and site URL as the app and the
 * other db:* scripts. The app itself must already be running (`npm run dev`), or
 * use `npm run e2e:ci`, which starts `npm start` (after a `next build`) first.
 *
 * The suite seeds the shared pre-launch Supabase project. Every seeder is
 * idempotent and scoped to the dedicated e2e user's `e2e-*` workspaces; every
 * spec that writes rows removes them in `after()`.
 *
 * Recording to Cypress Cloud is optional and deliberately not configured: add a
 * `projectId` here and run `cypress run --record` with CYPRESS_RECORD_KEY in
 * .env.local (never committed) if you want run history and Test Replay.
 */

/** Run a seeder and parse the one-line JSON answer it prints last. */
function seeder(script: string, ...args: string[]): unknown {
  const out = execFileSync(process.execPath, ["--use-system-ca", script, ...args], {
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").at(-1) ?? "");
}

const E2E_USER_EMAIL = process.env.CYPRESS_E2E_USER_EMAIL ?? "test@terragram.dev";
const E2E_USER_PASSWORD = process.env.CYPRESS_E2E_USER_PASSWORD ?? "terragram-test-1234";
/** The second person the members spec invites into the e2e user's org. */
const E2E_INVITEE_EMAIL = "e2e-invitee@terragram.dev";
const E2E_INVITEE_PASSWORD = "terragram-invitee-1234";

export default defineConfig({
  e2e: {
    baseUrl: process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
    specPattern: "cypress/e2e/**/*.cy.ts",
    supportFile: "cypress/support/e2e.ts",
    // Workspace and dashboard pages render on every request under `next dev`, so
    // give commands headroom over the 4s default.
    defaultCommandTimeout: 10000,
    retries: { runMode: 2, openMode: 0 },
    setupNodeEvents(on) {
      on("task", {
        /**
         * Idempotently create a CONFIRMED email/password user by shelling out to
         * the existing dev script — one source of truth for seeding, run with
         * `--use-system-ca` like every other db:* script.
         */
        seedUser({ email, password }: { email: string; password: string }) {
          execFileSync(
            process.execPath,
            ["--use-system-ca", "scripts/create-test-user.mjs", email, password],
            { stdio: "inherit" },
          );
          return null;
        },
        /**
         * Ensure the e2e user owns the deterministic fixture workspace
         * (`e2e-fixture-workspace`: a three-snapshot history ending in a web app,
         * a database and a cache). Yields its id and name. Precondition: the user exists (cy.login() guarantees it).
         */
        seedWorkspace(): { id: string; name: string; snapshots: number } {
          return seeder("scripts/e2e-seed-workspace.mjs", E2E_USER_EMAIL) as {
            id: string;
            name: string;
            snapshots: number;
          };
        },
        /**
         * Delete every `e2e-*` workspace the e2e user owns — the fixture and
         * anything a journey spec created and renamed — with their snapshots,
         * receipts and share links (all cascade). Never touches another user.
         */
        cleanupWorkspaces(): { cleaned: number } {
          return seeder("scripts/e2e-seed-workspace.mjs", E2E_USER_EMAIL, "--cleanup") as {
            cleaned: number;
          };
        },
        /**
         * Remove every `e2e-invitee*` member from the e2e user's org and delete
         * every pending invite to such an address. Never touches anyone else.
         */
        cleanupTeam(): { removedMembers: number; removedInvites: number } {
          return seeder("scripts/e2e-seed-team.mjs", E2E_USER_EMAIL, "e2e-invitee") as {
            removedMembers: number;
            removedInvites: number;
          };
        },
      });
    },
  },
  // `expose`, not `env`: Cypress 16 removed the synchronous `Cypress.env(key)`;
  // `Cypress.expose(key)` is the synchronous replacement. The CYPRESS_* override
  // is resolved HERE because that mechanism only ever populated `env`.
  expose: {
    // Defaults mirror scripts/create-test-user.mjs.
    E2E_USER_EMAIL,
    E2E_USER_PASSWORD,
    E2E_INVITEE_EMAIL,
    E2E_INVITEE_PASSWORD,
    // Opt-in: the signup spec creates a real account, so it is skipped by default.
    RUN_SIGNUP: process.env.CYPRESS_RUN_SIGNUP ?? "",
  },
  viewportWidth: 1440,
  viewportHeight: 900,
  video: false,
});
