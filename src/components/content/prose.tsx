import type * as React from "react";

import { cn } from "@/utils/cn";

/**
 * Long-form reading styles for docs and legal copy. Tailwind Typography isn't a
 * dependency here, so the type scale is expressed as descendant utilities and
 * kept on-brand with the warm earthy tokens from `globals.css`.
 *
 * Headings get `scroll-mt-24` so in-page anchor jumps clear the sticky header.
 */
export function Prose({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="prose"
      className={cn(
        // `prose-content` drives link styling from globals.css at low specificity
        // (so `.not-prose` card/button links opt out). See globals.css.
        "prose-content max-w-none text-sm leading-[1.72] text-ink-muted",
        // Headings
        "[&_h2]:mt-12 [&_h2]:mb-3.5 [&_h2]:scroll-mt-24 [&_h2]:text-xl [&_h2]:font-extrabold [&_h2]:tracking-[-0.02em] [&_h2]:text-foreground",
        "[&_h3]:mt-9 [&_h3]:mb-2.5 [&_h3]:scroll-mt-24 [&_h3]:text-base [&_h3]:font-bold [&_h3]:tracking-[-0.01em] [&_h3]:text-accent-foreground",
        "[&_h4]:mt-7 [&_h4]:mb-2 [&_h4]:text-sm [&_h4]:font-bold [&_h4]:text-accent-foreground",
        // First heading shouldn't push a big gap under the page header
        "[&>h2:first-child]:mt-0 [&>h3:first-child]:mt-0",
        // Body
        "[&_p]:my-4",
        "[&_strong]:font-semibold [&_strong]:text-accent-foreground",
        "[&_em]:italic",
        // Links are styled via the `.prose-content` rule in globals.css (low
        // specificity + `.not-prose` opt-out for card/button links).
        // Lists
        "[&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:marker:text-primary",
        "[&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:marker:font-semibold [&_ol]:marker:text-ink-muted",
        "[&_li]:my-1.5 [&_li]:pl-1",
        "[&_li>ul]:my-1.5",
        // Inline code
        "[&_code]:rounded-sm [&_code]:bg-surface-sunken [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:font-medium [&_code]:text-primary-hover [&_code]:before:content-[''] [&_code]:after:content-['']",
        // Don't double-style code already inside a <pre> (CodeBlock owns that)
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit",
        // Rules & quotes
        "[&_hr]:my-10 [&_hr]:border-border",
        "[&_blockquote]:my-5 [&_blockquote]:border-l-2 [&_blockquote]:border-input [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_blockquote]:italic",
        className,
      )}
      {...props}
    />
  );
}
