// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Transactional email via the Amazon SES v2 HTTPS API, signed with SigV4 (see
 * `./sigv4.ts`). No AWS SDK — just `fetch` + `crypto` — so the bundle stays lean
 * and the lockfile untouched.
 *
 * Credentials are a dedicated, send-only IAM key (`ses:SendEmail`) supplied as
 * `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY`; the app runs on Railway, not
 * AWS, so there is no instance role to inherit. They are read at call time, so
 * the module is import-safe during `next build` and holds no secret of its own —
 * which is also why it carries no `server-only` marker: a client bundle would
 * read `undefined` and send nothing, and the unit suite can drive it directly.
 */
import { errorMessage } from "@infraweaver-io/core/errors";
import { registerSecret } from "@infraweaver-io/core/redact";

import { APP_NAME, INVITES_EMAIL } from "@/config/brand";
import { featureConfigured } from "@/config/env";
import { logger } from "@/libs/log";
import { amzDate, sigv4AuthHeaders } from "@/libs/ses/sigv4";

const log = logger("ses/send-email");

/** London: the UK/EU residency the rest of the platform keeps to. */
const DEFAULT_REGION = "eu-west-2";

/** What an email template returns — the parts SES needs. */
export type RenderedEmail = { subject: string; html: string; text: string };

type Env = Record<string, string | undefined>;

/** The process environment and network, injectable so a test can drive both. */
type SendIo = { env: Env; fetch: typeof fetch };

/**
 * Send one best-effort transactional email. Returns whether it was actually
 * sent: `false` without an attempt when SES is not configured, `false` after a
 * logged warning when SES refuses or the call throws. It never throws, because
 * an email must never be able to fail the action that triggered it.
 *
 * `render` is a callback so the template stays a lazy `import()` in the caller,
 * out of this module's graph and out of the action's eager one.
 *
 * `EMAIL_FROM` overrides the sender; it must be an SES-verified identity.
 */
export async function sendTransactional(
  params: { to: string; label: string; render: () => Promise<RenderedEmail> },
  io: SendIo = { env: process.env, fetch },
): Promise<boolean> {
  const { env } = io;
  if (!featureConfigured("email", env)) return false;
  try {
    const { subject, html, text } = await params.render();
    const result = await sendEmail(
      {
        from: env.EMAIL_FROM?.trim() || `${APP_NAME} <${INVITES_EMAIL}>`,
        to: params.to,
        subject,
        html,
        text,
      },
      io,
    );
    if (!result.ok) {
      log.warn("email send failed", { label: params.label, err: result.error });
      return false;
    }
    return true;
  } catch (error) {
    log.warn("email send threw", { label: params.label, err: error });
    return false;
  }
}

/** Addresses out of a provider message before it is logged: SES names the
 *  recipient when it refuses one (an unverified address in the SES sandbox). */
function withoutAddresses(message: string): string {
  return message.replace(/[^\s@<>"',:;]+@[^\s@<>"',:;]+/g, "<address>");
}

async function sendEmail(
  params: { from: string; to: string; subject: string; html: string; text: string },
  { env, fetch: fetchImpl }: SendIo,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const accessKeyId = env.SES_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.SES_SECRET_ACCESS_KEY?.trim() ?? "";
  const region = env.SES_REGION?.trim() || DEFAULT_REGION;
  // The key id is masked by its AWS shape; the secret has no shape, so it is
  // masked by value in case an error ever quotes it.
  registerSecret(secretAccessKey);

  const body = JSON.stringify({
    FromEmailAddress: params.from,
    Destination: { ToAddresses: [params.to] },
    Content: {
      Simple: {
        Subject: { Data: params.subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: params.html, Charset: "UTF-8" },
          Text: { Data: params.text, Charset: "UTF-8" },
        },
      },
    },
  });

  const host = `email.${region}.amazonaws.com`;
  const path = "/v2/email/outbound-emails";
  const headers = sigv4AuthHeaders({
    method: "POST",
    host,
    path,
    body,
    region,
    service: "ses",
    accessKeyId,
    secretAccessKey,
    amzDate: amzDate(new Date()),
  });

  try {
    const res = await fetchImpl(`https://${host}${path}`, { method: "POST", headers, body });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const type = res.headers.get("x-amzn-errortype") ?? "";
      return { ok: false, error: `SES ${res.status} ${type}: ${withoutAddresses(detail.slice(0, 300))}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: withoutAddresses(errorMessage(err)) };
  }
}
