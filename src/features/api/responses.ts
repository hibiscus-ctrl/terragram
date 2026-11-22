import { NextResponse } from "next/server";
import type { z } from "zod";

/** Standard JSON error body: `{ error: string, ...extra }`. */
export function apiError(status: number, error: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...extra }, { status });
}

export function apiJson<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

/** Max accepted JSON body. A report with the schema-max 2000 findings is well
 *  under this; the cap stops a multi-hundred-MB body being buffered into memory
 *  (a cheap DoS) before zod ever runs. */
const MAX_BODY_BYTES = 2_000_000;

/**
 * Read a raw request body for handlers that need the exact bytes and therefore
 * can't go through `parseBody` — the Stripe/GitHub webhook receivers, which must
 * HMAC-verify the unparsed payload. Applies the same `MAX_BODY_BYTES` cap so an
 * oversized (or Content-Length–lying) body can't be buffered into memory before
 * the signature is even checked.
 */
export async function readRawBody(
  request: Request,
): Promise<{ ok: true; raw: string } | { ok: false; response: NextResponse }> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: apiError(413, "Request body too large") };
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return { ok: false, response: apiError(413, "Request body too large") };
  }
  return { ok: true, raw };
}

/**
 * Parse + validate a JSON request body against a zod schema.
 * Returns the parsed value or a 400 response describing the first issue.
 */
export async function parseBody<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: NextResponse }> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: apiError(413, "Request body too large") };
  }
  let raw: unknown;
  try {
    const text = await request.text();
    // Guard against a missing/lying Content-Length too.
    if (text.length > MAX_BODY_BYTES) {
      return { ok: false, response: apiError(413, "Request body too large") };
    }
    raw = text.length ? JSON.parse(text) : undefined;
  } catch {
    return { ok: false, response: apiError(400, "Invalid JSON body") };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".") || "body";
    return {
      ok: false,
      response: apiError(400, `Invalid ${path}: ${issue?.message ?? "validation failed"}`),
    };
  }
  return { ok: true, data: result.data };
}
