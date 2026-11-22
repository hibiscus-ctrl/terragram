// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import type * as React from "react";
import { Check, ChevronDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/utils/cn";

export type SelectOption = { value: string; label: string; hint?: string };

/**
 * Styled single-select built on the Radix dropdown primitive so every dropdown in
 * the app shares one look (instead of the unstyled native <select>). Trigger reads
 * like an input; the menu matches the trigger width and shows a check on the
 * current value. Works inside dialogs (portaled, never clipped).
 */
export function Select({
  value,
  onValueChange,
  options,
  id,
  ariaLabel,
  placeholder = "Select…",
  icon,
  className,
  contentClassName,
  disabled,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  icon?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
}) {
  const current = options.find((o) => o.value === value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          id={id}
          type="button"
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            "border-input bg-card flex w-full items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-left text-xs text-secondary-foreground outline-none transition-colors hover:bg-surface-subtle focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 data-[state=open]:border-primary",
            className,
          )}
        >
          <span
            className={cn(
              "flex min-w-0 items-center gap-2 truncate",
              !current && "text-muted-foreground",
            )}
          >
            {current?.label ?? placeholder}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
            {icon}
            <ChevronDown className="size-4 transition-transform" strokeWidth={1.7} aria-hidden />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className={cn(
          "w-[var(--radix-dropdown-menu-trigger-width)] min-w-[var(--radix-dropdown-menu-trigger-width)]",
          contentClassName,
        )}
      >
        {options.map((o) => {
          const active = o.value === value;
          return (
            <DropdownMenuItem
              key={o.value}
              onSelect={() => onValueChange(o.value)}
              className={cn("flex items-center justify-between gap-3", active && "bg-accent/60")}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-semibold">{o.label}</span>
                {o.hint && (
                  <span className="truncate text-2xs font-normal text-muted-foreground">
                    {o.hint}
                  </span>
                )}
              </span>
              {active && (
                <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
