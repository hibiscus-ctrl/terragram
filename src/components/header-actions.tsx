// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LayoutGrid, LogOut, Settings } from "lucide-react";
import { toast } from "sonner";

import { signOut } from "@/app/(auth)/auth-actions";
import { GITHUB_REPO_URL, hasPublicRepo } from "@/config/company";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createSupabaseBrowserClient } from "@/libs/supabase/supabase-client";
import type { User } from "@supabase/supabase-js";

type SessionUser = { name: string; email: string; initials: string };

/** Derive the display identity from a Supabase user (or null when signed out). */
function deriveUser(user: User | null): SessionUser | null {
  if (!user) return null;
  const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name =
    (typeof metadata.full_name === "string" && metadata.full_name) || user.email || "Account";
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0))
      .join("")
      .toUpperCase() ||
    user.email?.charAt(0).toUpperCase() ||
    "?";
  return { name, email: user.email ?? "", initials };
}

/**
 * The single, centralised right-hand side of the site header — used everywhere
 * (marketing, auth, dashboard). Reflects auth state client-side so static pages
 * stay static: signed-out visitors see GitHub + Log in; signed-in visitors see
 * GitHub + Go to dashboard + a profile menu (settings, sign out). `user === null`
 * pre-hydration shows the signed-out CTAs (the common case) and swaps once the
 * browser session resolves.
 */
export function HeaderActions() {
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    let active = true;
    supabase.auth.getUser().then(({ data }) => {
      if (active) setUser(deriveUser(data.user));
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(deriveUser(session?.user ?? null));
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function handleSignOut() {
    const response = await signOut();
    if (!response.ok) {
      toast.error("Could not sign you out. Please try again.");
      return;
    }
    // Full navigation so all client state is cleared and the auth guard re-evaluates.
    window.location.assign("/login");
  }

  return (
    <>
      {hasPublicRepo() && (
      <a
        href={GITHUB_REPO_URL}
        target="_blank"
        rel="noreferrer"
        aria-label="Terragram on GitHub"
        className="border-border bg-card text-foreground hover:bg-accent hidden size-9 items-center justify-center rounded-md border transition-colors sm:flex"
      >
        <span className="sr-only">Terragram on GitHub</span>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.35c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.81.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.51-1.07-1.78-.2-3.65-.89-3.65-3.96 0-.87.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.11.16 1.93.08 2.13.52.56.83 1.28.83 2.15 0 3.08-1.87 3.76-3.66 3.96.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
      </a>
      )}

      {user ? (
        <Button
          variant="outline"
          size="sm"
          className="h-9 border-input bg-transparent text-ink-soft hover:border-primary hover:bg-surface-sunken hover:text-primary-hover"
          asChild
        >
          <Link href="/workspace">Open workspace</Link>
        </Button>
      ) : (
        <Button variant="dark" size="sm" className="h-9" asChild>
          <Link href="/login">Log in</Link>
        </Button>
      )}

      {user && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Account menu for ${user.name}`}
              className="flex size-9 items-center justify-center rounded-full bg-linear-to-br from-warning to-primary text-xs font-bold text-white uppercase transition-[filter] outline-none hover:brightness-[1.06] focus-visible:ring-[3px] focus-visible:ring-ring/40"
            >
              {user.initials}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[212px]">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="truncate text-xs font-semibold">{user.name}</span>
              {user.email && (
                <span className="truncate text-2xs font-normal text-muted-foreground">
                  {user.email}
                </span>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/workspace">
                <LayoutGrid className="size-4" strokeWidth={1.7} /> Workspace
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/workspace/settings">
                <Settings className="size-4" strokeWidth={1.7} /> Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={handleSignOut}>
              <LogOut className="size-4" strokeWidth={1.7} /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}
