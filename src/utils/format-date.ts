// Dates shown by client components. Those render twice — on the server (Railway:
// en-US, UTC) and again in the browser (the visitor's locale and zone) — and any
// difference in the text is a hydration mismatch (React #418). So the locale and
// time zone are fixed here, and nothing in a client component calls `toLocale*()`.
const DATE = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });
const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function parse(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "10 Oct 2026". Empty for an unparseable timestamp. */
export function formatDate(iso: string): string {
  const date = parse(iso);
  return date ? DATE.format(date) : "";
}

/** "10 Oct 2026, 14:05 UTC". Empty for an unparseable timestamp. */
export function formatDateTime(iso: string): string {
  const date = parse(iso);
  return date ? `${DATE_TIME.format(date)} UTC` : "";
}

/**
 * "just now" / "5m ago" / "2h ago" / "yesterday" / "3d ago" / a date, measured
 * from `now`. `now` is a parameter, not `Date.now()`, because the server and the
 * hydrating browser read the clock at different moments: a caller passes the
 * browser's clock only once mounted (see WorkspaceRow).
 */
export function relativeTime(iso: string, now: number): string {
  const date = parse(iso);
  if (!date) return "";
  const minutes = Math.round((now - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "yesterday";
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return DATE.format(date);
}
