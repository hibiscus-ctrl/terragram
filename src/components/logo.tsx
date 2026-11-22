// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";

import { cn } from "@/utils/cn";

// The Terragram mark: a dark rounded square holding a monospaced "TG", the same
// lockup used in the product splash. Rendered in pure CSS so it stays crisp at
// any size and inherits the theme tokens (no raster asset to keep in sync).
export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-7 place-items-center rounded-lg bg-foreground font-mono text-[12px] font-semibold tracking-tight text-background select-none",
        className,
      )}
    >
      TG
    </span>
  );
}

export function Logo({ className, href = "/" }: { className?: string; href?: string }) {
  return (
    // The accessible name is built from the link's own contents rather than an
    // aria-label: an aria-label that merely paraphrases the visible wordmark makes
    // the name and the label diverge (WCAG 2.5.3), which is what a voice-control
    // user says out loud. The destination is carried by a visually hidden word.
    <Link href={href} className={cn("flex w-fit items-center gap-2.5", className)}>
      <LogoMark />
      <span className="flex flex-col leading-none">
        <span className="text-[17px] font-bold tracking-[-0.01em] text-foreground">Terragram</span>
        <span className="mt-1 h-[3px] w-9 rounded-full bg-primary" />
      </span>
      <span className="sr-only">home</span>
    </Link>
  );
}
