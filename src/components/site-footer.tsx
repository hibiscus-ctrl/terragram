// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";

import { footerColumns } from "@/config/navigation";
import { LogoMark } from "@/components/logo";
import { companyLine } from "@/config/company";
import { cn } from "@/utils/cn";

/** Renders an internal Next link or a plain anchor for external/hash hrefs. */
function FooterLink({ href, label }: { href: string; label: string }) {
  const external = href.startsWith("http");
  const className = "text-xs text-surface-muted transition-colors hover:text-surface-foreground";
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {label}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {label}
    </Link>
  );
}

/** The single, centralised site footer — used by every layout (marketing, auth,
 *  dashboard). `widthClass` sets the centred content column so it lines up with the
 *  header and page above it; the dark band itself always spans the viewport. */
export function SiteFooter({ widthClass = "max-w-page" }: { widthClass?: string }) {
  return (
    <footer className="mt-auto border-t border-[#322a1c] bg-[#1c1710] text-surface-muted">
      <div className={cn("mx-auto px-7 py-14", widthClass)}>
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(4,1fr)]">
          {/* Brand */}
          <div className="max-w-[260px]">
            <div className="flex items-center gap-2.5">
              <LogoMark className="size-6 rounded-md shadow-none" />
              <span className="text-surface-foreground text-sm font-bold">Terragram</span>
            </div>
            <p className="mt-3.5 text-xs leading-[1.6]">
              Plain English, diagrams and Terraform, one auditable model. Built for the UK public
              sector, open to everyone.
            </p>
            <div className="border-surface-border bg-surface mt-4 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-2xs font-semibold text-[#c2b8a8]">
              <span className="size-1.5 rounded-full bg-surface-dot" />
              Data stays in the UK 🇬🇧
            </div>
          </div>

          {/* Link columns */}
          {footerColumns.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <h2 className="mb-3.5 text-2xs font-bold tracking-[0.08em] text-[#9b907e] uppercase">
                {col.title}
              </h2>
              <ul className="flex flex-col gap-2.5">
                {col.items.map((item) => (
                  <li key={item.label}>
                    <FooterLink href={item.href} label={item.label} />
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-[#2c2417] pt-6 text-xs sm:flex-row sm:items-center">
          <span>
            © 2026 {companyLine() || "Terragram"} · AGPL-3.0 open core · Data resident in the UK
            (London)
          </span>
          <div className="flex items-center gap-5">
            <Link href="/privacy" className="transition-colors hover:text-surface-foreground">
              Privacy
            </Link>
            <Link href="/cookies" className="transition-colors hover:text-surface-foreground">
              Cookies
            </Link>
            <Link href="/terms" className="transition-colors hover:text-surface-foreground">
              Terms
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
