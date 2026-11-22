/**
 * Minimal AWS Signature Version 4 signer — enough to call the Amazon SES v2
 * HTTPS API directly, with no `@aws-sdk/*` dependency (keeps the server bundle
 * small and the lockfile untouched). Built on Node's `crypto` only.
 *
 * Validated against AWS's own published worked example in `tests/ses-sigv4.test.ts`.
 */
import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * Derive the SigV4 signing key: an HMAC chain over the date, region, service,
 * and the `aws4_request` terminator. Each link keys the next.
 */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

type Sigv4Input = {
  method: string;
  host: string;
  /** Request path, already URI-encoded (e.g. "/v2/email/outbound-emails"). */
  path: string;
  /** Canonical query string (empty for the POST sends). */
  query?: string;
  /** The exact request body string that will be sent. */
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** ISO8601 basic timestamp `yyyymmddThhmmssZ`; injected so callers and tests own the clock. */
  amzDate: string;
  contentType?: string;
};

/**
 * Sign `input` and return the HTTP headers to send — `authorization`,
 * `x-amz-date`, and `content-type`. The three are the signed header set
 * (`content-type;host;x-amz-date`), matching AWS's reference example.
 */
export function sigv4AuthHeaders(input: Sigv4Input): Record<string, string> {
  const contentType = input.contentType ?? "application/json";
  const query = input.query ?? "";
  const dateStamp = input.amzDate.slice(0, 8);

  const payloadHash = sha256Hex(input.body);

  // Canonical headers are sorted by lowercased name and newline-terminated.
  const canonicalHeaders = `content-type:${contentType}\nhost:${input.host}\nx-amz-date:${input.amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-date";

  const canonicalRequest = [input.method, input.path, query, canonicalHeaders, signedHeaders, payloadHash].join(
    "\n",
  );

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [ALGORITHM, input.amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = deriveSigningKey(input.secretAccessKey, dateStamp, input.region, input.service);
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const authorization = `${ALGORITHM} Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    "content-type": contentType,
    "x-amz-date": input.amzDate,
    authorization,
  };
}

/** Format a Date as the SigV4 basic timestamp `yyyymmddThhmmssZ`. */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}
