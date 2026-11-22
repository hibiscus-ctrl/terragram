import { constantTimeEqual } from "@/utils/crypto";

/**
 * The gate in front of every scheduler-facing job route (`/api/jobs/*`), behind
 * injected collaborators so its ordering is unit-testable without a booted
 * server. `jobs-secret.ts` binds the adapters.
 *
 * None of these routes are user-facing: a scheduler (Supabase `pg_cron` +
 * `pg_net`) pokes them on an interval with the one operator credential they all
 * share, `JOBS_DRAIN_SECRET`, sent as `x-jobs-secret`.
 */

/** A shorter secret is refused at request time, and `config/env.ts` reports it. */
export const JOBS_SECRET_MIN_LENGTH = 16;

/** What a job route needs to identify itself in the log and the limiter. */
export type JobsSecretOptions = {
  /** Route name for the refusal log line, e.g. `jobs/flush-usage`. */
  label: string;
  /** What an unset secret turns off, phrased to follow "so … is disabled." */
  disables: string;
  /** Rate-limit bucket prefix; the effective key is `${key}:${clientIp}`. */
  key: string;
  /** Per-IP requests allowed per minute. */
  limit: number;
};

export type JobsSecretDeps<R> = {
  /** The configured secret, read per call rather than captured at import. */
  secret: () => string | undefined;
  clientIp: (request: Request) => string;
  /** A ready-to-return refusal once the window is exhausted, else `null`. */
  rateLimited: (key: string, opts: { limit: number; windowMs: number }) => Promise<R | null>;
  /** The one refusal every failing caller gets. */
  unauthorized: () => R;
  warn: (message: string, meta: Record<string, unknown>) => void;
};

/**
 * Returns the gate: an error response to short-circuit the handler, or `null` to
 * proceed.
 *
 * - **Unconfigured answers exactly as a wrong secret does: 401.** With no secret
 *   set there is nothing to authenticate against, so every caller IS
 *   unauthenticated, and the reply describes the request rather than the server.
 *   A 501 naming the variable would tell an anonymous caller how this deployment
 *   is set up; `/api/health/ready` is the one place configuration presence is
 *   published. The actionable message goes to the log, where an operator can act
 *   on it.
 * - **The flood guard sits in front of the compare**, so a caller guessing the
 *   secret burns its per-IP budget. It sits behind the configuration check, so an
 *   unconfigured deployment spends no limiter round trip on a request it refuses.
 */
export function makeRequireJobsSecret<R>(deps: JobsSecretDeps<R>) {
  return async function requireJobsSecret(
    request: Request,
    opts: JobsSecretOptions,
  ): Promise<R | null> {
    const secret = deps.secret();
    if (!secret || secret.length < JOBS_SECRET_MIN_LENGTH) {
      deps.warn(`refused: JOBS_DRAIN_SECRET is unset or under ${JOBS_SECRET_MIN_LENGTH} chars`, {
        label: opts.label,
        disables: opts.disables,
      });
      return deps.unauthorized();
    }

    const limited = await deps.rateLimited(`${opts.key}:${deps.clientIp(request)}`, {
      limit: opts.limit,
      windowMs: 60_000,
    });
    if (limited) return limited;

    const provided = request.headers.get("x-jobs-secret") ?? "";
    return constantTimeEqual(provided, secret) ? null : deps.unauthorized();
  };
}
