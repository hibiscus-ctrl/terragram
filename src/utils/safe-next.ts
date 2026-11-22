// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `next` path to land on after signing in, or null when the value is not a
 * path on this site. A crafted link must not turn sign-in into an open redirect.
 *
 * Checking for a leading `/` is not enough: a browser reads `//host` and `/\host`
 * as protocol-relative, and drops tabs and newlines before it parses, so
 * `/<tab>/host` is the same thing. Resolving against a placeholder origin and
 * requiring that origin back catches every such form, and the normalised path is
 * what is returned, so the raw string is never reinterpreted downstream.
 */
const PLACEHOLDER_ORIGIN = "http://same-origin.invalid";

export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw?.startsWith("/")) return null;
  let url: URL;
  try {
    url = new URL(raw, PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
