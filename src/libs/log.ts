import { errorMessage } from "@infraweaver-io/core/errors";
import { registerTokenPrefix, redactSecrets } from "@infraweaver-io/core/redact";

/**
 * The server-side log sink: one redacted JSON record per line.
 *
 * The redaction is `@infraweaver-io/core` — the same masking Infraweaver Cloud
 * and the engine use — rather than a second implementation here. It masks by
 * literal registered value, by credential-shaped JSON property name, by
 * `Authorization: Bearer …`, by known token shapes, and by AWS access-key id.
 *
 * WHY THIS EXISTS. Terragram logs the failure paths of things that carry
 * credentials: the managed-model gateway (a `tmpx_` HMAC token in an
 * `authorization` header), the Git-host OAuth round trip (a provider access
 * token in the exchange response), Stripe (an error echoing the key prefix it was
 * called with) and Postgres (an error quoting the offending value). A thrown
 * error routinely embeds the request it failed on, so `console.error(err)` on
 * those paths is a credential-disclosure seam even though nothing ever logs the
 * token on purpose.
 *
 * `tmpx_` is registered as a token SHAPE, so a token is masked whether or not it
 * was ever registered by value — a minted token lives for one request and is
 * never seen by this module.
 *
 * **JSON lines**, so the platform's log store can index `scope`, `level` and any
 * field instead of an operator grepping free text. Redaction runs over the
 * FINISHED line rather than field by field: a secret can be nested inside an
 * object a caller passed whole, and the key-name masking only works when the key
 * sits beside its value. The redactor substitutes inside string literals, so the
 * line stays parseable.
 *
 * **The level floor is read per call** from `LOG_LEVEL` (default `info`), so it
 * takes effect on a redeploy and a test cannot leak a floor into the next one.
 *
 * Client Components keep `console.error`: the browser console is the right sink
 * there, and this module's redactor would be dead weight in the client bundle.
 */
registerTokenPrefix("tmpx_");

type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Anything worth writing beside the message. Errors are unwrapped, not stringified. */
type LogFields = Record<string, unknown>;

/** An unrecognised `LOG_LEVEL` falls back to `info` — a typo must not silence logging. */
function floor(): number {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  return ORDER[raw as LogLevel] ?? ORDER.info;
}

/**
 * Make a field JSON-safe. `JSON.stringify(new Error())` is `{}`, so an Error
 * logged as a field would otherwise vanish; `errorMessage` also renders a
 * PostgREST rejection (`{ message, code }`, not an Error) and unwraps `cause`.
 *
 * Strings are redacted HERE as well as on the finished line: once a string is
 * JSON-encoded its quotes are escaped, so a provider body quoted inside an error
 * message (`{"access_token":"…"}`) no longer looks like a credential-named
 * property to the line-level pass.
 */
function serialise(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: redactSecrets(errorMessage(value)) };
  }
  if (typeof value === "string") return redactSecrets(value);
  if (value === undefined) return null;
  return value;
}

function write(level: LogLevel, scope: string, message: string, fields?: LogFields): void {
  if (ORDER[level] < floor()) return;

  const base = { level, scope, message: redactSecrets(message), time: new Date().toISOString() };
  const record: Record<string, unknown> = { ...base };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) record[key] = serialise(value);
  }

  let line: string;
  try {
    line = redactSecrets(JSON.stringify(record));
  } catch {
    // A circular field must not turn a log call into a throw on the request path.
    line = redactSecrets(JSON.stringify({ ...base, fields: "[unserialisable]" }));
  }

  // Level picks the stream: platforms route stderr separately and alert on it.
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

/**
 * A logger for one subsystem. `scope` is the grep key (`"api/webhooks"`,
 * `"billing/metering"`); bind it once at module level so it cannot drift from the
 * module it names.
 */
export function logger(scope: string): Logger {
  return {
    debug: (message, fields) => write("debug", scope, message, fields),
    info: (message, fields) => write("info", scope, message, fields),
    warn: (message, fields) => write("warn", scope, message, fields),
    error: (message, fields) => write("error", scope, message, fields),
  };
}

