// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { errorMessage } from "@infraweaver-io/core/errors";
import { redactSecrets } from "@infraweaver-io/core/redact";

/**
 * Turning a thrown value into (a) one structured server-side log record and
 * (b) one opaque token the caller may safely be shown.
 *
 * A route boundary answers every failure with fixed prose, which is right — a
 * Postgres error names columns and often values. But that alone leaves support
 * with nothing: a user reporting "it 500s" and an operator reading the logs have
 * no way to find each other's record of the same request. Pages get this from
 * Next (a `digest` crosses to the browser, the error stays in the log); route
 * handlers do not, so this supplies the equivalent — an `incident_id` that is
 * meaningless on its own and joins the two records.
 *
 * Pure and free of `next/*` on purpose, so what is logged, what is redacted and
 * what the client may see are unit-testable. The Next-coupled half
 * (`unstable_rethrow`, the `NextResponse`) lives in `route-errors.ts`.
 */

/** Injected in tests; production passes `crypto.randomUUID`. */
export type IdSource = () => string;

/**
 * Name a route for the log from the request it is handling: `METHOD /path`.
 * Derived rather than hand-written so renaming a route folder cannot leave the
 * log reporting the old path.
 */
export function requestLabel(value: unknown): string {
  if (!(value instanceof Request)) return "unknown route";
  try {
    return `${value.method} ${new URL(value.url).pathname}`;
  } catch {
    return value.method;
  }
}

export type Incident = {
  /** Opaque correlation token. Safe to return: random, and meaningless alone. */
  incidentId: string;
  /** The single structured record to write to the server log. */
  record: {
    event: "route_error";
    incident_id: string;
    label: string;
    name: string;
    message: string;
    stack?: string;
    /** Present when the thrown value carried a `cause`. */
    cause?: string;
  };
};

/** A `throw` need not be an Error — a Supabase client can reject with a plain object. */
function describe(value: unknown): { name: string; message: string; stack?: string } {
  const message = errorMessage(value);
  if (value instanceof Error) {
    return { name: value.name, message, ...(value.stack ? { stack: value.stack } : {}) };
  }
  return { name: "NonError", message };
}

/**
 * Build the incident for a thrown value. Every string that reaches the record is
 * redacted first — including the stack, whose frames can embed a URL with a token
 * in its query string.
 */
export function buildIncident(error: unknown, label: string, newId: IdSource): Incident {
  // 12 hex chars: short enough to read down a phone line, wide enough not to
  // collide within one log window.
  const incidentId = newId().replace(/-/g, "").slice(0, 12);
  const { name, message, stack } = describe(error);
  const cause =
    error instanceof Error && error.cause !== undefined
      ? redactSecrets(describe(error.cause).message)
      : undefined;

  return {
    incidentId,
    record: {
      event: "route_error",
      incident_id: incidentId,
      label,
      name,
      message: redactSecrets(message),
      ...(stack ? { stack: redactSecrets(stack) } : {}),
      ...(cause ? { cause } : {}),
    },
  };
}

/**
 * The body every unhandled route failure answers with: a stable machine code,
 * fixed prose, and the join key. Nothing derived from the thrown value.
 */
export function internalErrorBody(incidentId: string) {
  return {
    error: "internal_error",
    message: "The request could not be completed. Quote this reference if you contact support.",
    incident_id: incidentId,
  };
}
