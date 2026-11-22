// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { makeRequireJobsSecret } from "@/features/api/jobs-secret-core";
import { clientIp, rateLimited } from "@/features/api/rate-limit-route";
import { apiError } from "@/features/api/responses";
import { logger } from "@/libs/log";

const log = logger("api/jobs-secret");

/**
 * Gate a scheduler-facing job route on `JOBS_DRAIN_SECRET`. The decisions (401
 * when unconfigured, the flood guard before the compare) live in
 * `jobs-secret-core.ts`.
 */
export const requireJobsSecret = makeRequireJobsSecret({
  secret: () => process.env.JOBS_DRAIN_SECRET,
  clientIp,
  rateLimited,
  unauthorized: () => apiError(401, "unauthorized"),
  warn: (message, meta) => log.warn(message, meta),
});
