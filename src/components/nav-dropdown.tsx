// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";

import type { NavChild } from "@/components/site-nav";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/utils/cn";

/**
 * A desktop primary-nav entry that opens a dropdown of curated links (e.g. Docs
 * → the key guides, with the MCP servers featured). Click/keyboard-driven via
 * the shared Radix DropdownMenu, so it's accessible and touch-friendly; the
 * chevron flips while open. The trigger highlights when any child route is active.
 */
export function NavDropdown({ label, items }: { label: string; items: readonly NavChild[] }) {
  const pathname = usePathname();
  const active = items.some((item) =>
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href),
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "group inline-flex items-center gap-1 outline-none transition-colors hover:text-primary focus-visible:text-primary data-[state=open]:text-primary",
          active && "text-primary",
        )}
      >
        {label}
        <ChevronDown
          className="size-3.5 transition-transform duration-200 group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={10} className="w-72">
        {items.map((item) => (
          <DropdownMenuItem key={item.href} asChild className="flex-col items-start gap-0.5 px-2.5 py-2">
            <Link href={item.href}>
              <span className="text-sm font-semibold text-foreground">{item.label}</span>
              {item.description && (
                <span className="text-xs leading-snug text-muted-foreground">{item.description}</span>
              )}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
