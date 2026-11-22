// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { clientIp, rateLimited } from "@/features/api/rate-limit-route";
import { withRouteErrors } from "@/features/api/route-errors";
import { logger } from "@/libs/log";

const log = logger("api/csp-report");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/csp-report — the collector for the Report-Only CSP soak in
 * `src/utils/csp.ts`. Without it the browser evaluates the policy, finds
 * violations and discards them, so "the soak came back clean" and "the soak never
 * ran" are indistinguishable — which is what makes an uninstrumented policy worse
 * than no policy.
 *
 * UNAUTHENTICATED ON PURPOSE, and that is the design constraint. A browser posts a
 * report with no credentials, cannot be given any, and never reads the response —
 * so every protection here bounds what a stranger can make this endpoint do:
 *
 *   - a body cap (a real report is well under 8 KB);
 *   - a per-IP rate limit;
 *   - a cap on violations PER REQUEST, because the byte cap bounds bytes and not
 *     log lines, and the sampling below is per violation KEY — keys a forged
 *     request chooses;
 *   - a bounded key table with powers-of-ten sampling, so a repeated violation
 *     costs one line rather than one per report;
 *   - `document-uri` reduced to origin + path before it reaches a log line,
 *     because in this app that URL can carry a share token or an auth code.
 *
 * The reply is always 204: there is no caller to inform, and distinguishing
 * "accepted" from "malformed" would only tell a prober what shape to send next.
 */

/** A report body is small; anything larger is not a report. */
const MAX_REPORT_BYTES = 32_000;

/** Violations logged from one request, however many the body claims. */
const MAX_REPORTS_PER_REQUEST = 10;

/**
 * Distinct violation keys held in memory. The map exists to SUPPRESS logging, so
 * it must not itself become the leak: past the cap we stop counting and log every
 * new key's first sighting instead — noisier, never silent. One replica, one map:
 * the Railway deploy is pinned to a single instance and the soak's output is that
 * process's log stream anyway.
 */
const MAX_TRACKED_KEYS = 500;
const seen = new Map<string, number>();

type Violation = {
  directive: string;
  blocked: string;
  documentUri: string;
};

/** Origin + path only — query and fragment can carry a share token or auth code. */
function safeUrl(value: unknown): string {
  if (typeof value !== "string" || value === "") return "(none)";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    // `blob:`, `data:`, `inline`, `eval` and friends are not parseable URLs.
    return value.slice(0, 60);
  }
}

/**
 * Both report shapes, because the browsers split: `report-uri` posts
 * `{ "csp-report": {...} }`, the Reporting API (`report-to`) posts an array of
 * `{ type: "csp-violation", body: {...} }`.
 */
function parseReports(raw: unknown): Violation[] {
  const bodies: Record<string, unknown>[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const body = (entry as { body?: unknown })?.body;
      if (body && typeof body === "object") bodies.push(body as Record<string, unknown>);
    }
  } else if (raw && typeof raw === "object") {
    const legacy = (raw as { "csp-report"?: unknown })["csp-report"];
    if (legacy && typeof legacy === "object") bodies.push(legacy as Record<string, unknown>);
  }

  return bodies.slice(0, MAX_REPORTS_PER_REQUEST).map((body) => ({
    directive: String(body.effectiveDirective ?? body["effective-directive"] ?? "unknown").slice(
      0,
      40,
    ),
    blocked: safeUrl(body.blockedURL ?? body["blocked-uri"]),
    documentUri: safeUrl(body.documentURL ?? body["document-uri"]),
  }));
}

/** Log the 1st, 10th, 100th … sighting of a key, so volume costs log lines slowly. */
function shouldLog(key: string): boolean {
  if (seen.size >= MAX_TRACKED_KEYS && !seen.has(key)) return true;
  const next = (seen.get(key) ?? 0) + 1;
  seen.set(key, next);
  return next === 1 || next % 10 ** Math.floor(Math.log10(next)) === 0;
}

async function handlePost(request: Request) {
  const limited = await rateLimited(`csp-report:${clientIp(request)}`, {
    limit: 30,
    windowMs: 60_000,
  });
  if (limited) return new Response(null, { status: 204 });

  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_REPORT_BYTES) {
    return new Response(null, { status: 204 });
  }

  try {
    const text = await request.text();
    if (text.length <= MAX_REPORT_BYTES) {
      for (const v of parseReports(JSON.parse(text))) {
        const key = `${v.directive}|${v.blocked}`;
        if (shouldLog(key)) {
          log.warn("csp-violation", {
            directive: v.directive,
            blocked: v.blocked,
            document: v.documentUri,
            count: seen.get(key) ?? 1,
          });
        }
      }
    }
  } catch {
    // Malformed body: there is no caller to tell, and saying so only helps a prober.
  }

  return new Response(null, { status: 204 });
}

export const POST = withRouteErrors(handlePost);
