"use client";

import { useEffect } from "react";

/**
 * Global error boundary — the last-resort fallback for errors thrown by the
 * root layout itself (where `error.tsx` cannot reach). It replaces the whole
 * document, so it renders its own `<html>`/`<body>` and is fully self-contained:
 * inline styles instead of Tailwind, a plain anchor instead of `next/link`, and
 * an inline icon — none of the app chrome is assumed to have loaded.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 1.5rem",
          textAlign: "center",
          backgroundColor: "#faf8f4",
          color: "#211c16",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <div role="alert" style={{ maxWidth: 520 }}>
          <div
            style={{
              margin: "0 auto 1rem",
              width: 48,
              height: 48,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 12,
              backgroundColor: "#f6e7df",
              color: "#b23a22",
            }}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
          </div>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700, letterSpacing: "-0.02em", margin: 0 }}>
            Something went wrong
          </h1>
          <p
            style={{
              marginTop: "0.5rem",
              fontSize: "0.875rem",
              lineHeight: 1.6,
              color: "#8a8073",
            }}
          >
            This is usually transient — try again, and if it persists, head back home and check in
            shortly.
          </p>
          <div
            style={{
              marginTop: "1.25rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "0.625rem",
            }}
          >
            <button
              type="button"
              onClick={reset}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.5rem",
                height: 40,
                padding: "0 1rem",
                borderRadius: 8,
                border: "none",
                cursor: "pointer",
                fontSize: "0.875rem",
                fontWeight: 600,
                backgroundColor: "#211c16",
                color: "#faf8f4",
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
              Try again
            </button>
            {/* oxlint-disable-next-line no-html-link-for-pages -- the global error boundary renders when the app tree
                has failed; the router it would need is exactly what may be broken. */}
            <a
              href="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                height: 40,
                padding: "0 1rem",
                borderRadius: 8,
                border: "1px solid #e4ddd0",
                textDecoration: "none",
                fontSize: "0.875rem",
                fontWeight: 600,
                color: "#211c16",
              }}
            >
              Go home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
