import type * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { legalNav } from "@/config/navigation";
import { breadcrumbSchema } from "@/config/structured-data";
import { Prose } from "@/components/content/prose";
import { JsonLd } from "@/components/seo/json-ld";
import { cn } from "@/utils/cn";

/**
 * Shared layout for the legal / support pages. Centered at the landing-page
 * width (1120px) with a right-hand `<aside>` that links between every connecting
 * page (active state highlighted). On mobile the aside drops below the content.
 *
 * `current` is the page's own href so the aside can mark it active and the
 * breadcrumb can label it — keeps the whole thing a server component.
 */
export function LegalShell({
  current,
  eyebrow,
  title,
  updated,
  intro,
  children,
}: {
  current: string;
  eyebrow: string;
  title: string;
  /** e.g. "15 June 2026" — shown for policy pages. */
  updated?: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
}) {
  const active = legalNav.find((i) => i.href === current);

  return (
    <div className="mx-auto max-w-page px-7 py-12 lg:py-16">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: active?.label ?? title, path: current },
        ])}
      />
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_15rem] lg:gap-14">
        {/* Main content */}
        <article className="min-w-0">
          <nav
            aria-label="Breadcrumb"
            className="text-muted-foreground mb-5 flex items-center gap-1.5 text-xs"
          >
            <Link href="/" className="hover:text-foreground transition-colors">
              Home
            </Link>
            <ChevronRight className="size-3.5" aria-hidden />
            <span className="font-medium text-ink-soft">{active?.label ?? title}</span>
          </nav>

          <header className="border-border mb-9 border-b pb-7">
            <p className="text-primary mb-2.5 text-xs font-bold tracking-[0.07em] uppercase">
              {eyebrow}
            </p>
            <h1 className="text-[clamp(28px,4.4vw,38px)] leading-[1.08] font-extrabold tracking-[-0.03em] text-foreground">
              {title}
            </h1>
            {updated && (
              <p className="text-muted-foreground mt-3 text-xs">
                Last updated <time>{updated}</time>
              </p>
            )}
            {intro && (
              <div className="mt-4 max-w-[680px] text-base leading-[1.55] text-pretty text-ink-soft">
                {intro}
              </div>
            )}
          </header>

          <Prose className="max-w-[720px]">{children}</Prose>
        </article>

        {/* Right-hand aside nav */}
        <aside className="mt-12 lg:mt-0">
          <div className="lg:sticky lg:top-24">
            <nav
              aria-label="Related pages"
              className="border-border bg-card rounded-xl border p-2 lg:bg-transparent"
            >
              <h2 className="text-muted-foreground px-3 pt-2 pb-2 text-2xs font-bold tracking-[0.08em] uppercase lg:pt-0">
                More pages
              </h2>
              <ul className="flex flex-col gap-0.5">
                {legalNav.map((item) => {
                  const isActive = item.href === current;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          "block rounded-md px-3 py-1.5 text-xs transition-colors",
                          isActive
                            ? "text-primary bg-surface-sunken font-semibold"
                            : "hover:text-foreground font-medium text-ink-soft hover:bg-wash",
                        )}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>

            {current !== "/contact" && (
              <div className="mt-5 hidden rounded-xl border border-line-strong bg-surface-sunken p-4 lg:block">
                <p className="text-xs font-bold text-accent-foreground">Still stuck?</p>
                <p className="mt-1 text-xs leading-[1.5] text-muted-foreground">
                  Can&rsquo;t find what you need? Our team is one message away.
                </p>
                <Link
                  href="/contact"
                  className="text-primary mt-2.5 inline-flex items-center gap-1 text-xs font-semibold hover:underline"
                >
                  Contact us <ChevronRight className="size-3.5" aria-hidden />
                </Link>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
