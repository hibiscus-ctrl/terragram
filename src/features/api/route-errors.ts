import { randomUUID } from "node:crypto";

import { unstable_rethrow } from "next/navigation";
import { NextResponse } from "next/server";

import { buildIncident, internalErrorBody, requestLabel } from "@/features/api/error-capture";
import { apiJson } from "@/features/api/responses";
import { logger } from "@/libs/log";

const log = logger("api/route-error");

/**
 * The last-resort error boundary for route handlers.
 *
 * **Why routes need their own.** `error.tsx` does not cover them: Next's app-route
 * module intercepts only `redirect()` and the HTTP access fallbacks, and re-throws
 * everything else past any React boundary. An uncaught handler throw is a bare
 * framework 500 whose body is not JSON, which every client of these routes parses
 * as `{ error }`.
 *
 * **Why `unstable_rethrow` comes first.** `redirect()`, `notFound()`, a dynamic
 * bailout and postpone signals are all implemented AS throws. A catch-all that
 * swallowed them would turn a working redirect into a 500. `unstable_rethrow`
 * re-throws exactly that set and returns for anything genuinely ours, so it must
 * be the first statement in the catch.
 *
 * The caller gets a fixed code, fixed prose and an opaque `incident_id`; the error
 * itself goes to the log as one redacted record under the same id.
 */
function makeRouteErrorBoundary(toResponse: (incidentId: string) => Response) {
  return function boundary<A extends unknown[], R extends Response>(
    handler: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R | Response> {
    return async (...args: A) => {
      try {
        return await handler(...args);
      } catch (error) {
        unstable_rethrow(error);
        const { incidentId, record } = buildIncident(error, requestLabel(args[0]), randomUUID);
        const { message, ...rest } = record;
        log.error(message, rest);
        return toResponse(incidentId);
      }
    };
  };
}

/** Wrap a JSON route handler so a throw becomes the standard `{ error }` 500. */
export const withRouteErrors = makeRouteErrorBoundary((incidentId) =>
  apiJson(internalErrorBody(incidentId), 500),
);

/**
 * The boundary for a route whose whole contract is a REDIRECT — the auth callback
 * and confirm links, the Git OAuth return leg, the billing-portal hop. A person
 * following a link must not land on raw JSON or a framework error page mid-flow,
 * so a throw degrades to `target` (absolute — `NextResponse.redirect` requires it)
 * and is still captured under an incident id.
 */
export function withRedirectErrors(target: string) {
  return makeRouteErrorBoundary(() => NextResponse.redirect(target));
}
