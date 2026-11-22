import type { Metadata } from "next";
import Link from "next/link";
import {
  Accessibility,
  ArrowRight,
  Check,
  FileSignature,
  type LucideIcon,
  MapPin,
  Share2,
  Shuffle,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";

// The Terragram capability showcase: one page that maps what the product does to
// the feature groups a buyer evaluates. Static Server Component with a
// self-referential canonical.
export const metadata: Metadata = {
  title: "Features",
  description:
    "Everything Terragram does: four translation modes through one auditable model, bidirectional and multi-cloud, a human review gate with signed evidence, UK data residency, and an interface anyone can use.",
  alternates: { canonical: "/features" },
};

type FeatureGroup = {
  eyebrow: string;
  icon: LucideIcon;
  tile: string;
  title: string;
  intro: string;
  features: string[];
};

const GROUPS: FeatureGroup[] = [
  {
    eyebrow: "Translate",
    icon: Share2,
    tile: "bg-cat-storage-bg text-cat-storage",
    title: "Four modes, one model",
    intro:
      "Move between plain English, architecture diagrams and Terraform in any direction, and switch modes any time without losing context.",
    features: [
      "Chat to Diagram: describe it and watch the diagram build.",
      "Chat to Terraform: plain English to review-ready code.",
      "Diagram to Terraform: upload a screenshot, or draw it on the canvas.",
      "Terraform to Diagram: reverse-engineer a diagram from code.",
    ],
  },
  {
    eyebrow: "Stay in sync",
    icon: Shuffle,
    tile: "bg-cat-network-bg text-cat-network",
    title: "Bidirectional and multi-cloud",
    intro:
      "Words, diagram and code are three views of one internal model, so they never drift apart, and the same model can target either cloud.",
    features: [
      "Start from a sentence, a diagram, or existing code.",
      "Target AWS or Azure from the same model.",
      "Bring diagrams in and export them back out.",
      "Terraform and OpenTofu output.",
    ],
  },
  {
    eyebrow: "Trust",
    icon: FileSignature,
    tile: "bg-cat-compute-bg text-cat-compute",
    title: "Review gate and signed evidence",
    intro:
      "Nothing becomes code until a human approves the model, and every generation ships with evidence an auditor will accept.",
    features: [
      "A human reviews the model before any code is generated.",
      "Uncertain decisions are flagged for you to confirm.",
      "Signed SBOM and plan attached to every generation.",
      "Opens a pull request on GitHub or GitLab; never applies infrastructure.",
    ],
  },
  {
    eyebrow: "Residency",
    icon: MapPin,
    tile: "bg-cat-security-bg text-cat-security",
    title: "UK data residency",
    intro:
      "Built for the UK public sector, so residency is a promise, not a setting. Your data stays in the UK and inference runs in region.",
    features: [
      "Data at rest in the UK (UK South / UK West).",
      "Managed, in-region UK inference.",
      "Never used to train models, never shared with third parties.",
      "Enterprise: BYOK, private endpoints, audit-log export and a DPA.",
    ],
  },
  {
    eyebrow: "For everyone",
    icon: Accessibility,
    tile: "bg-cat-storage-bg text-cat-storage",
    title: "Plain-language and accessible",
    intro:
      "You shouldn't need to know Terraform, or a mouse, to describe infrastructure. Terragram meets people where they are.",
    features: [
      "Describe infrastructure in plain English.",
      "Keyboard and screen-reader ready.",
      "Free for the public sector, charities and learners.",
      "Standards-based output you can take anywhere.",
    ],
  },
];

export default function FeaturesPage() {
  return (
    <div className="mx-auto max-w-page px-6 py-20">
      <header className="max-w-2xl">
        <p className="mb-3 font-mono text-2xs font-semibold tracking-[0.14em] text-primary uppercase">
          Features
        </p>
        <h1 className="text-3xl font-bold tracking-[-0.03em] text-foreground sm:text-4xl">
          Everything between an idea and shippable infrastructure.
        </h1>
        <p className="mt-4 text-lg text-ink-muted">
          Terragram translates plain English, diagrams and Terraform through one
          auditable model, with a human review gate and UK data residency built
          in.
        </p>
      </header>

      <div className="mt-14 flex flex-col gap-16">
        {GROUPS.map((g) => (
          <section
            key={g.title}
            className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-12"
          >
            <div>
              <span
                className={`flex size-11 items-center justify-center rounded-xl ${g.tile}`}
                aria-hidden
              >
                <g.icon className="size-5" strokeWidth={1.7} />
              </span>
              <p className="mt-4 font-mono text-2xs font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                {g.eyebrow}
              </p>
              <h2 className="mt-1 text-xl font-bold tracking-[-0.01em] text-foreground">
                {g.title}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                {g.intro}
              </p>
            </div>
            <ul className="grid content-start gap-3 sm:grid-cols-2">
              {g.features.map((f) => (
                <li
                  key={f}
                  className="flex items-start gap-2.5 rounded-xl border border-border bg-card p-4 text-sm text-ink-soft"
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
          </section>
        ))}
      </div>

      <div className="mt-20 flex flex-col items-center gap-4 rounded-2xl border border-border bg-wash p-10 text-center">
        <Sparkles
          className="size-6 text-primary"
          strokeWidth={1.7}
          aria-hidden
        />
        <h2 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
          See it on your own architecture.
        </h2>
        <p className="max-w-md text-ink-muted">
          Start for free, no card required. Describe what you need and watch it
          become infrastructure.
        </p>
        <div className="mt-2 flex flex-wrap justify-center gap-3">
          <Button size="lg" asChild>
            <Link href="/signup">Start for free</Link>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <Link href="/docs/quickstart">
              Read the quickstart <ArrowRight className="size-4" aria-hidden />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
