// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Next's boot hook — runs once per server start, before the first request.
 *
 * It writes the environment report to the log so that a half-configured
 * deployment says so at deploy time rather than at first use. See `config/env.ts`
 * for why "half-configured" is the case worth catching.
 *
 * **It reports; it never throws.** Aborting the boot on a partial feature set
 * would take a running deployment down for something that is, for most of these,
 * a deliberate choice. The readiness probe is where a deploy gate belongs, and it
 * already fails on an unreachable database.
 *
 * **Node runtime only, with dynamic imports inside the guard.** `register` runs in
 * every runtime the deployment starts, edge included, and the logger reaches
 * `@infraweaver-io/core/redact` — a static import here would pull that graph into
 * the edge bundle for a report the edge runtime has nothing to say about.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const [{ checkEnv }, { logger }] = await Promise.all([
    import("@/config/env"),
    import("@/libs/log"),
  ]);

  const log = logger("boot");
  const report = checkEnv();

  if (report.missing.length > 0) {
    log.error("required environment variables are missing — the app cannot serve", {
      missing: report.missing,
    });
  }
  if (report.weak.length > 0) {
    log.error("environment values below the length the runtime accepts", { weak: report.weak });
  }
  for (const [feature, absent] of Object.entries(report.incomplete)) {
    log.error("feature is HALF configured — it will fail at first use, not now", {
      feature,
      missing: absent,
    });
  }

  // The positive line too: "which features is this box actually running?" is the
  // first question of every incident.
  log.info("environment checked", { ok: report.ok, features: report.features });
}
