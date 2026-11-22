// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client (reads the auth cookie client-side). Used by marketing
 * components that need to reflect signed-in state without forcing the page to be
 * dynamically rendered. Mirrors the server client's key fallback (new publishable
 * key → legacy anon key).
 */
export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/ANON_KEY",
    );
  }
  return createBrowserClient(url, key);
}
