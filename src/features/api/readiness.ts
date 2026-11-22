import type { EnvReport } from "@/config/env";

/**
 * The readiness decision, apart from the route that gathers its inputs, so it is
 * unit-testable without a booted server or a database.
 *
 * - 503 when the database is unreachable — the app cannot serve anything real.
 * - 200 otherwise. A half-configured feature is REPORTED, not failed on: most
 *   features are optional, and a restart loop would not fix a missing variable.
 *   The boot log carries the same report.
 */
export function readiness(input: { databaseOk: boolean; env: EnvReport; now: Date }) {
  const { databaseOk, env, now } = input;
  return {
    status: databaseOk ? 200 : 503,
    body: {
      status: databaseOk ? "ready" : "unavailable",
      checks: {
        database: databaseOk,
        // Names, not values — this endpoint is reachable by uptime monitors.
        env: {
          ok: env.ok,
          missing: env.missing,
          weak: env.weak,
          incomplete: env.incomplete,
          features: env.features,
        },
      },
      time: now.toISOString(),
    },
  };
}
