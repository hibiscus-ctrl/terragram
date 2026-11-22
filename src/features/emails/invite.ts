import { APP_NAME } from "@/config/brand";

/**
 * The org-invite email: inline-styled HTML, a plain-text part and a subject, for
 * `sendTransactional`. Hand-rolled rather than React Email so the lockfile stays
 * lean, the same reasoning as the SDK-free SES client.
 *
 * Every caller-supplied string (org, role, inviter, link) is escaped before it
 * reaches the HTML. The text part carries them raw: it is not markup.
 */

/** DESIGN.md tokens, as literals: a mail client has no stylesheet to resolve a
 *  `var()` against. The names are the tokens they mirror. */
const C = {
  background: "#faf8f4",
  card: "#ffffff",
  border: "#e9e3d7",
  surface: "#211d16",
  surfaceForeground: "#e9e3d7",
  foreground: "#211d16",
  inkMuted: "#5d5647",
  inkFaint: "#746a5c",
  primary: "#a8512a",
  primaryForeground: "#ffffff",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BODY_LINE = `Accept it to work on the organisation's diagrams and Terraform in ${APP_NAME}.`;
const CTA = "Accept invitation";
const PASTE_HINT = "Or paste this link into your browser:";
const EXPIRY = "This invitation works once and expires in 14 days. If you weren't expecting it, you can ignore this email.";

export function InviteEmail({
  inviteUrl,
  orgName,
  role,
  invitedBy,
}: {
  inviteUrl: string;
  orgName: string;
  /** The role's display label, e.g. "Billing Manager". */
  role: string;
  invitedBy: string | null;
}): { subject: string; html: string; text: string } {
  const org = escapeHtml(orgName);
  const roleLabel = escapeHtml(role);
  const url = escapeHtml(inviteUrl);
  const who = invitedBy ? `${invitedBy} invited you` : "You have been invited";
  const whoHtml = invitedBy ? `${escapeHtml(invitedBy)} invited you` : "You have been invited";

  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" /></head>
  <body style="margin:0;background:${C.background};padding:40px 8px;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(`${who} to ${orgName} on ${APP_NAME}`)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr><td align="center">
        <table role="presentation" width="464" cellpadding="0" cellspacing="0" style="width:464px;max-width:464px;border-collapse:collapse;border:1px solid ${C.border};border-radius:12px;overflow:hidden;background:${C.card};">
          <tr><td style="background:${C.surface};padding:40px 32px;text-align:center;">
            <p style="margin:0;font-size:15px;font-weight:700;letter-spacing:-0.01em;color:${C.surfaceForeground};">${APP_NAME}</p>
            <h1 style="margin:12px 0 0;font-size:26px;font-weight:700;color:${C.primaryForeground};">Join ${org} on ${APP_NAME}</h1>
          </td></tr>
          <tr><td style="padding:32px;">
            <p style="margin:0;font-size:15px;line-height:1.6;color:${C.inkMuted};">${whoHtml} to the <strong style="color:${C.foreground};">${org}</strong> organisation with the <strong style="color:${C.foreground};">${roleLabel}</strong> role.</p>
            <p style="margin:12px 0 20px;font-size:15px;line-height:1.6;color:${C.inkMuted};">${escapeHtml(BODY_LINE)}</p>
            <a href="${url}" style="display:inline-block;border-radius:8px;background:${C.primary};padding:12px 20px;font-size:14px;font-weight:600;color:${C.primaryForeground};text-decoration:none;">${CTA}</a>
            <p style="margin:24px 0 0;font-size:12.5px;line-height:1.6;color:${C.inkFaint};">${PASTE_HINT}<br /><a href="${url}" style="word-break:break-all;color:${C.primary};text-decoration:underline;">${url}</a></p>
            <p style="margin:16px 0 0;font-size:12px;color:${C.inkFaint};">${escapeHtml(EXPIRY)}</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  const text = [
    `${who} to the ${orgName} organisation on ${APP_NAME} with the ${role} role.`,
    "",
    BODY_LINE,
    "",
    `${CTA}: ${inviteUrl}`,
    "",
    EXPIRY,
  ].join("\n");

  return { subject: `You're invited to ${orgName} on ${APP_NAME}`, html, text };
}
