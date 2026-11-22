import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, BookOpen, MapPin, Rocket, Share2, ShieldCheck } from "lucide-react";

import { docsNav } from "@/config/navigation";

export const metadata: Metadata = {
  title: "Documentation",
  alternates: { canonical: "/docs" },
  description:
    "How Terragram works: the one-model translation between plain English, diagrams and Terraform, the four modes, the review gate, and UK data residency.",
};

export default function DocsIndexPage() {
  return (
    <div>
      <header className="mb-9 border-b border-border pb-7">
        <p className="mb-2.5 font-mono text-xs font-semibold tracking-[0.1em] text-primary uppercase">
          Documentation
        </p>
        <h1 className="text-[clamp(28px,4vw,36px)] leading-[1.08] font-bold tracking-[-0.03em] text-foreground">
          One model, in any direction.
        </h1>
        <p className="mt-3.5 text-base leading-[1.5] text-pretty text-muted-foreground">
          Terragram translates between plain English, architecture diagrams and Terraform through one
          auditable model. These guides cover the four modes, the human review gate and signed
          evidence, and where your data lives.
        </p>
      </header>

      {/* Quickstart callout */}
      <section aria-labelledby="quickstart" className="mb-12">
        <h2 id="quickstart" className="mb-1.5 text-lg font-bold tracking-[-0.02em] text-foreground">
          New here?
        </h2>
        <p className="text-sm leading-[1.6] text-ink-muted">
          Start with the{" "}
          <Link href="/docs/quickstart" className="font-medium text-primary underline underline-offset-2">
            quickstart
          </Link>
          : open a workspace, describe what you need, review the model, and get Terraform in a few
          minutes.
        </p>
      </section>

      {/* Card grid */}
      {docsNav.map((section) => {
        const sectionId = section.title.toLowerCase().replace(/\s+/g, "-");
        return (
          <section key={section.title} aria-labelledby={sectionId} className="mb-10">
            <h2
              id={sectionId}
              className="mb-4 font-mono text-2xs font-semibold tracking-[0.1em] text-muted-foreground uppercase"
            >
              {section.title}
            </h2>
          <div className="grid gap-3.5 sm:grid-cols-2">
            {section.items
              .filter((item) => item.href !== "/docs")
              .map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group flex flex-col rounded-xl border border-border bg-card p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-input hover:shadow-[0_6px_18px_rgba(46,38,24,0.08)]"
                >
                  <div className="mb-2 flex items-center gap-2.5">
                    <DocIcon href={item.href} />
                    <span className="text-sm font-bold text-foreground">{item.label}</span>
                  </div>
                  <p className="flex-1 text-xs leading-[1.55] text-muted-foreground">
                    {item.description}
                  </p>
                  <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary">
                    Read
                    <ArrowRight
                      className="size-3.5 transition-transform group-hover:translate-x-0.5"
                      aria-hidden
                    />
                  </span>
                </Link>
              ))}
          </div>
          </section>
        );
      })}
    </div>
  );
}

function DocIcon({ href }: { href: string }) {
  const cls =
    "flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-primary";
  const Icon = href.includes("quickstart")
    ? Rocket
    : href.includes("modes")
      ? Share2
      : href.includes("review")
        ? ShieldCheck
        : href.includes("residency")
          ? MapPin
          : BookOpen;
  return (
    <span className={cls}>
      <Icon className="size-4" strokeWidth={1.7} />
    </span>
  );
}
