// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { entryRatePence, formatGbp } from "@/config/pricing";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Free for public good. Terragram is free for the public sector, charities and learners, with paid tiers for teams that need Terraform output, the review gate and signed evidence.",
  alternates: { canonical: "/pricing" },
};

type Plan = {
  name: string;
  price: string;
  per: string;
  tag: string;
  cta: string;
  href: string;
  featured: boolean;
  features: string[];
};

const PLANS: Plan[] = [
  {
    name: "Community",
    price: "Free",
    per: "",
    tag: "Public sector, charities & learners",
    cta: "Start for free",
    href: "/signup",
    featured: false,
    features: [
      "Unlimited diagrams",
      "Chat and diagram modes",
      "Managed UK inference as a metered add-on",
      "Export SVG diagrams",
      "Community support",
    ],
  },
  {
    name: "Team",
    price: `from ${formatGbp(entryRatePence())}`,
    per: "/ seat / month",
    tag: "Growing platform teams",
    cta: "Start with Team",
    href: "/signup",
    featured: true,
    features: [
      "Everything in Community",
      "Terraform and OpenTofu output",
      "Review gate and signed evidence",
      "GitHub and GitLab pull requests",
      "AWS and Azure targets",
      "Priority support",
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    per: "",
    tag: "NHS trusts & central government",
    cta: "Talk to us",
    href: "/contact",
    featured: false,
    features: [
      "Everything in Team",
      "BYOK and private endpoints",
      "SSO / SAML sign-in",
      "Audit log and 99.9% SLA",
      "Dedicated success manager",
      "Procurement via G-Cloud",
    ],
  },
];

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-page px-6 py-20">
      <header className="mx-auto max-w-2xl text-center">
        <p className="mb-3 font-mono text-2xs font-semibold tracking-[0.14em] text-primary uppercase">
          Pricing
        </p>
        <h1 className="text-3xl font-bold tracking-[-0.03em] text-foreground sm:text-4xl">
          Free for public good.
        </h1>
        <p className="mt-4 text-lg text-ink-muted">
          Terragram is free for the public sector, charities and learners. Teams
          that need Terraform output, the review gate and signed evidence pay
          per seat.
        </p>
      </header>

      <div className="mt-12 grid items-start gap-5 lg:grid-cols-3">
        {PLANS.map((plan) => (
          <div
            key={plan.name}
            className={
              plan.featured
                ? "relative rounded-2xl border-2 border-primary bg-card p-7 shadow-[0_10px_26px_rgba(46,38,24,0.1)]"
                : "rounded-2xl border border-border bg-card p-7"
            }
          >
            {plan.featured && (
              <span className="absolute -top-3 left-7 rounded-full bg-primary px-3 py-1 font-mono text-2xs font-semibold tracking-[0.06em] text-primary-foreground uppercase">
                Most popular
              </span>
            )}
            <h2 className="text-lg font-bold tracking-[-0.01em] text-foreground">
              {plan.name}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{plan.tag}</p>
            <p className="mt-5 flex items-baseline gap-1.5">
              <span className="text-3xl font-bold tracking-[-0.02em] text-foreground tabular-nums">
                {plan.price}
              </span>
              {plan.per && (
                <span className="text-sm text-muted-foreground">
                  {plan.per}
                </span>
              )}
            </p>
            <Button
              className="mt-5 w-full"
              variant={plan.featured ? "default" : "outline"}
              asChild
            >
              <Link href={plan.href}>{plan.cta}</Link>
            </Button>
            <ul className="mt-6 flex flex-col gap-3">
              {plan.features.map((f) => (
                <li
                  key={f}
                  className="flex items-start gap-2.5 text-sm text-ink-soft"
                >
                  <Check
                    className="mt-0.5 size-4 shrink-0 text-cat-compute"
                    strokeWidth={2.2}
                    aria-hidden
                  />
                  {f}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="mx-auto mt-10 max-w-xl text-center text-sm text-muted-foreground">
        All plans keep your data in the UK and route inference through managed
        UK endpoints. Nothing becomes code without passing the human review
        gate.
      </p>
    </div>
  );
}
