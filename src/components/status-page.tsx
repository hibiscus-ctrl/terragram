import type * as React from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

type Action = { label: string; href: string };

/**
 * Centered status screen for 404 / 403 and similar dead-ends. Kept chrome-free
 * so it can sit inside the marketing layout (which supplies header + footer) or
 * be wrapped with its own chrome by the root `not-found` boundary.
 */
export function StatusPage({
  code,
  icon: Icon,
  title,
  message,
  primary,
  secondary,
  links,
}: {
  code: string;
  icon: LucideIcon;
  title: string;
  message: React.ReactNode;
  primary: Action;
  secondary?: Action;
  /** Small row of helpful links under the actions. */
  links?: Action[];
}) {
  return (
    <section className="mx-auto flex max-w-page flex-col items-center px-7 py-24 text-center lg:py-32">
      <span className="mb-6 flex size-16 items-center justify-center rounded-2xl bg-surface-sunken text-primary">
        <Icon className="size-8" strokeWidth={1.6} aria-hidden />
      </span>
      <p className="mb-3 font-mono text-xs font-semibold tracking-[0.12em] text-primary">{code}</p>
      <h1 className="text-[clamp(28px,5vw,42px)] leading-[1.06] font-extrabold tracking-[-0.03em] text-foreground">
        {title}
      </h1>
      <div className="mt-4 max-w-[480px] text-base leading-[1.55] text-muted-foreground text-pretty">
        {message}
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Button size="lg" asChild>
          <Link href={primary.href}>{primary.label}</Link>
        </Button>
        {secondary && (
          <Button size="lg" variant="outline" asChild>
            <Link href={secondary.href}>{secondary.label}</Link>
          </Button>
        )}
      </div>

      {links && links.length > 0 && (
        <div className="mt-10 border-t border-border pt-6">
          <p className="mb-3 text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Or try one of these
          </p>
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm font-medium">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-primary transition-colors hover:text-primary-hover"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      )}
    </section>
  );
}
