// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

// Shown instantly while a dashboard route's server data resolves (Next.js streaming).
// This single fallback covers EVERY (app) route (Repositories, Compliance, Members,
// Billing, SSO, Settings, Suppressions…), so it stays deliberately route-agnostic:
// a page heading plus a few neutral content blocks. A repositories-shaped skeleton
// here would flash the wrong layout — and a visible shift — on every other page.

const shimmer = "animate-pulse motion-reduce:animate-none rounded bg-surface-sunken";

export default function AppLoading() {
  return (
    <div className="w-full px-4 pt-6 pb-16 sm:px-8 sm:pt-8" aria-busy="true">
      <span className="sr-only" role="status">
        Loading…
      </span>

      {/* Page heading — common to every dashboard route */}
      <div className="mb-7 space-y-2.5">
        <div className={`h-7 w-52 ${shimmer}`} />
        <div className={`h-4 w-80 max-w-full ${shimmer}`} />
      </div>

      {/* Neutral content blocks: a band of cards then a larger panel. Generic enough
          that no route visibly "snaps" when its real content streams in. */}
      <div className="mb-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-card px-4 py-5">
            <div className={`mb-3 h-3.5 w-24 ${shimmer}`} />
            <div className={`h-6 w-20 ${shimmer}`} />
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className={`mb-4 h-4 w-40 ${shimmer}`} />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className={`h-4 ${shimmer}`} style={{ width: `${92 - i * 9}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
