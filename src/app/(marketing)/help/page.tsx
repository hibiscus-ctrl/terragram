// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  CreditCard,
  type LucideIcon,
  MapPin,
  Rocket,
  Share2,
  ShieldCheck,
} from "lucide-react";

import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
  title: "Help centre",
  description:
    "Find your way around Terragram: the quickstart, the four modes, the review gate, data residency and pricing, plus a fast path to human support.",
  alternates: { canonical: "/help" },
};

const TOPICS: { href: string; icon: LucideIcon; title: string; body: string }[] = [
  {
    href: "/docs/quickstart",
    icon: Rocket,
    title: "Getting started",
    body: "Open a workspace, describe what you need, and get Terraform in minutes.",
  },
  {
    href: "/docs/modes",
    icon: Share2,
    title: "The four modes",
    body: "Chat, diagram and Terraform, in any direction, through one model.",
  },
  {
    href: "/docs/review-gate",
    icon: ShieldCheck,
    title: "The review gate",
    body: "Approve the model and get a signed SBOM and plan before code lands.",
  },
  {
    href: "/docs/residency",
    icon: MapPin,
    title: "Data residency",
    body: "Where your data lives and how managed UK inference works.",
  },
  {
    href: "/pricing",
    icon: CreditCard,
    title: "Billing & plans",
    body: "Community (free), Team, and Enterprise via G-Cloud.",
  },
];

export default function HelpPage() {
  return (
    <LegalShell
      current="/help"
      eyebrow="Support"
      title="Help centre"
      intro={
        <>
          Everything you need to get going with Terragram. Start with a topic below, read the docs,
          or talk to a human when you&rsquo;d rather just ask.
        </>
      }
    >
      <h2 id="browse-by-topic">Browse by topic</h2>
      <div className="not-prose my-6 grid gap-4 sm:grid-cols-2">
        {TOPICS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="group flex flex-col rounded-xl border border-border bg-card p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-input hover:shadow-[0_6px_18px_rgba(46,38,24,0.08)]"
          >
            <span className="mb-3 flex size-9 items-center justify-center rounded-lg bg-surface-sunken text-primary">
              <t.icon className="size-4" strokeWidth={1.7} aria-hidden />
            </span>
            <span className="text-sm font-bold text-foreground">{t.title}</span>
            <span className="mt-1 text-xs leading-[1.5] text-muted-foreground">{t.body}</span>
            <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary">
              Open
              <ArrowRight
                className="size-3.5 transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </span>
          </Link>
        ))}
      </div>

      <h2 id="common-questions">Common questions</h2>
      <p>
        Most quick answers live in the <Link href="/faq">FAQ</Link>, including &ldquo;Do I need to
        know Terraform?&rdquo; (no, describe it in plain English) and &ldquo;Does it deploy
        anything?&rdquo; (never: a human approves the model at the review gate, and you merge the
        pull request).
      </p>

      <h2 id="contact-support">Still need a hand?</h2>
      <div className="not-prose my-6 flex flex-col items-start gap-3 rounded-xl border border-line-strong bg-surface-sunken p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-bold text-foreground">Talk to a human</p>
          <p className="text-xs text-muted-foreground">
            A bug, a compliance question, or &ldquo;does it handle this shape?&rdquo; We read every
            message.
          </p>
        </div>
        <Link
          href="/contact"
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:brightness-95"
        >
          Contact support <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>
    </LegalShell>
  );
}
