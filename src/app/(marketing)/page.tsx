import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Building2,
  Check,
  FileCode2,
  FileSignature,
  GraduationCap,
  HandHeart,
  HeartPulse,
  MapPin,
  MessagesSquare,
  Rocket,
  ScrollText,
  Server,
  Share2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { JsonLd } from "@/components/seo/json-ld";
import { siteGraph } from "@/config/structured-data";
import { FORMAT_CHIP, FORMAT_LABEL, MODE_LIST } from "@/features/workspace/modes";

// The homepage inherits the root layout's title/description/OG; it just needs a
// self-referential canonical so the most important SEO page isn't left without one.
export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

const STEPS = [
  {
    num: "1",
    title: "Describe or upload",
    body: "Type what you need in plain English, upload a screenshot of a diagram, or paste existing Terraform.",
    icon: MessagesSquare,
    tone: "bg-cat-network-bg text-cat-network",
  },
  {
    num: "2",
    title: "Review the model",
    body: "See the live diagram, fix anything the model flagged as uncertain, and pick AWS or Azure.",
    icon: Share2,
    tone: "bg-cat-security-bg text-cat-security",
  },
  {
    num: "3",
    title: "Generate and ship",
    body: "Get Terraform or OpenTofu plus a signed evidence bundle, ready for a pull request.",
    icon: FileCode2,
    tone: "bg-cat-compute-bg text-cat-compute",
  },
];

const BIPOINTS = [
  "Chat, diagram and code stay in sync automatically",
  "Switch between AWS and Azure from one model",
  "Bring existing diagrams in, export them back out",
];

const TRIAD = [
  { label: "Text", sub: "plain English", icon: MessagesSquare },
  { label: "Diagram", sub: "architecture", icon: Share2 },
  { label: "Terraform", sub: "compliant code", icon: FileCode2 },
];

const AUDIENCES = [
  {
    title: "NHS & health trusts",
    body: "Stand up patient-facing services with data residency and audit evidence built in.",
    icon: HeartPulse,
    tone: "bg-cat-security-bg text-cat-security",
  },
  {
    title: "Central & local government",
    body: "Ship compliant infrastructure that stands up to governance and procurement review.",
    icon: Building2,
    tone: "bg-cat-network-bg text-cat-network",
  },
  {
    title: "Universities & students",
    body: "Learn cloud architecture by describing it, then read the Terraform it produced.",
    icon: GraduationCap,
    tone: "bg-cat-storage-bg text-cat-storage",
  },
  {
    title: "Charities & community groups",
    body: "No budget for a platform team? Describe what you need and deploy it safely.",
    icon: HandHeart,
    tone: "bg-cat-compute-bg text-cat-compute",
  },
  {
    title: "SMEs & startups",
    body: "Move from idea to review-ready infrastructure without hiring a Terraform expert first.",
    icon: Rocket,
    tone: "bg-cat-security-bg text-cat-security",
  },
];

const TRUST = [
  { label: "Data residency", value: "UK South / UK West", icon: MapPin },
  { label: "Inference", value: "In-region, managed", icon: Server },
  { label: "Audit trail", value: "Every change logged", icon: ScrollText },
  { label: "Evidence", value: "Signed SBOM + plan", icon: FileSignature },
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 font-mono text-2xs font-semibold tracking-[0.14em] text-primary uppercase">
      {children}
    </p>
  );
}

export default function LandingPage() {
  return (
    <>
      <JsonLd data={siteGraph()} />

      {/* Hero */}
      <section className="mx-auto max-w-page px-6 pt-20 pb-16 sm:pt-28">
        <div className="max-w-3xl">
          <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface-subtle px-3 py-1 font-mono text-2xs font-semibold tracking-[0.06em] text-primary-hover uppercase">
            Diagram-first · Terraform &amp; OpenTofu
          </span>
          <h1 className="text-4xl font-bold tracking-[-0.03em] text-foreground sm:text-5xl sm:leading-[1.05]">
            Describe what you need. We build the infrastructure.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-muted">
            Terragram turns plain English and diagrams into compliant, auditable
            cloud infrastructure, no Terraform expertise required. Built for the
            UK public sector, open to everyone.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button size="lg" asChild>
              <Link href="/signup">Start for free</Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="#how">
                See how it works <ArrowRight className="size-4" aria-hidden />
              </Link>
            </Button>
          </div>
          <ul className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
            {["UK data residency", "Human review gate", "Open to everyone"].map(
              (t) => (
                <li key={t} className="flex items-center gap-1.5">
                  <Check
                    className="size-4 text-cat-compute"
                    strokeWidth={2.2}
                    aria-hidden
                  />
                  {t}
                </li>
              ),
            )}
          </ul>
        </div>
      </section>

      {/* Used-by strip */}
      <section className="border-y border-line bg-card">
        <div className="mx-auto flex max-w-page flex-wrap items-center gap-x-8 gap-y-3 px-6 py-5">
          <span className="font-mono text-2xs font-semibold tracking-[0.1em] text-muted-foreground uppercase">
            Built for teams across
          </span>
          {[
            "NHS Digital",
            "GOV.UK",
            "Local councils",
            "Universities",
            "Charities",
          ].map((u) => (
            <span key={u} className="text-sm font-semibold text-ink-soft">
              {u}
            </span>
          ))}
        </div>
      </section>

      {/* Four modes */}
      <section className="mx-auto max-w-page px-6 py-20">
        <Eyebrow>The four modes</Eyebrow>
        <h2 className="max-w-2xl text-2xl font-bold tracking-[-0.02em] text-foreground sm:text-[2rem]">
          Start from words, a diagram, or code.
        </h2>
        <p className="mt-3 max-w-xl text-ink-muted">
          Pick a direction. Every mode runs through one internal model, so you
          can switch at any time and nothing drifts.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {/* The cards read from MODE_LIST, the same source the workspace's own mode
              picker uses, so what the homepage promises and what the product offers
              cannot drift apart. */}
          {MODE_LIST.map((m) => (
            <Link
              key={m.id}
              href="/signup"
              className="group rounded-xl border border-border bg-card p-6 transition-[transform,box-shadow,border-color] hover:-translate-y-0.5 hover:border-foreground hover:shadow-[0_6px_18px_rgba(46,38,24,0.08)] focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none"
            >
              <div className="mb-4 flex items-center gap-2.5">
                <span
                  className={`rounded-md px-2 py-1 font-mono text-2xs font-semibold ${FORMAT_CHIP[m.from]}`}
                >
                  {FORMAT_LABEL[m.from]}
                </span>
                <ArrowRight className="size-4 text-ink-faint" aria-hidden />
                <span
                  className={`rounded-md px-2 py-1 font-mono text-2xs font-semibold ${FORMAT_CHIP[m.to]}`}
                >
                  {FORMAT_LABEL[m.to]}
                </span>
              </div>
              <h3 className="text-lg font-bold tracking-[-0.01em] text-foreground">
                {m.title}
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                {m.body}
              </p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-primary">
                Start
                <ArrowRight
                  className="size-4 transition-transform group-hover:translate-x-0.5"
                  aria-hidden
                />
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="scroll-mt-20 border-y border-line bg-wash">
        <div className="mx-auto max-w-page px-6 py-20">
          <Eyebrow>How it works</Eyebrow>
          <h2 className="max-w-2xl text-2xl font-bold tracking-[-0.02em] text-foreground sm:text-[2rem]">
            Three steps, one source of truth.
          </h2>
          <p className="mt-3 max-w-xl text-ink-muted">
            Everything flows through one internal model, so your words, your
            diagram, and your code never drift apart.
          </p>
          <ol className="mt-8 grid gap-5 md:grid-cols-3">
            {STEPS.map((s) => (
              <li
                key={s.num}
                className="rounded-xl border border-border bg-card p-6"
              >
                <span
                  className={`flex size-10 items-center justify-center rounded-lg ${s.tone}`}
                  aria-hidden
                >
                  <s.icon className="size-5" strokeWidth={1.7} />
                </span>
                <p className="mt-4 font-mono text-2xs font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                  Step {s.num}
                </p>
                <h3 className="mt-1 text-lg font-bold tracking-[-0.01em] text-foreground">
                  {s.title}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                  {s.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Bidirectional dark band */}
      <section className="bg-surface text-surface-foreground">
        <div className="mx-auto grid max-w-page items-center gap-12 px-6 py-20 lg:grid-cols-2">
          <div>
            <p className="mb-3 font-mono text-2xs font-semibold tracking-[0.14em] text-surface-muted uppercase">
              Bidirectional
            </p>
            <h2 className="text-2xl font-bold tracking-[-0.02em] sm:text-[2rem]">
              Translate in any direction.
            </h2>
            <p className="mt-3 max-w-md leading-relaxed text-surface-muted">
              Start from a sentence, a diagram, or existing code. Terragram
              keeps all three in sync and lets you target AWS or Azure from the
              same model.
            </p>
            <ul className="mt-6 flex flex-col gap-3">
              {BIPOINTS.map((b) => (
                <li key={b} className="flex items-start gap-3">
                  <span
                    className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-surface-dot"
                    aria-hidden
                  >
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                  <span className="text-surface-foreground/90">{b}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex items-center justify-center gap-3 sm:gap-4">
            {TRIAD.map((t, i) => (
              <div key={t.label} className="contents">
                <div className="flex-1 rounded-xl border border-surface-border bg-surface-2 p-5 text-center">
                  <t.icon
                    className="mx-auto size-6 text-surface-dot"
                    strokeWidth={1.7}
                    aria-hidden
                  />
                  <p className="mt-2.5 text-sm font-semibold">{t.label}</p>
                  <p className="text-2xs text-surface-muted">{t.sub}</p>
                </div>
                {i < TRIAD.length - 1 && (
                  <ArrowRight
                    className="size-4 shrink-0 text-surface-muted"
                    aria-hidden
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Audiences */}
      <section className="mx-auto max-w-page px-6 py-20">
        <Eyebrow>Who it&rsquo;s for</Eyebrow>
        <h2 className="max-w-2xl text-2xl font-bold tracking-[-0.02em] text-foreground sm:text-[2rem]">
          Infrastructure anyone can describe.
        </h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {AUDIENCES.map((a) => (
            <div
              key={a.title}
              className="rounded-xl border border-border bg-card p-6"
            >
              <span
                className={`flex size-10 items-center justify-center rounded-lg ${a.tone}`}
                aria-hidden
              >
                <a.icon className="size-5" strokeWidth={1.7} />
              </span>
              <h3 className="mt-4 text-base font-bold tracking-[-0.01em] text-foreground">
                {a.title}
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                {a.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Trust */}
      <section className="border-y border-line bg-card">
        <div className="mx-auto max-w-page px-6 py-16">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {TRUST.map((t) => (
              <div key={t.label} className="flex items-start gap-3">
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-primary"
                  aria-hidden
                >
                  <t.icon className="size-4" strokeWidth={1.7} />
                </span>
                <div>
                  <p className="font-mono text-2xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                    {t.label}
                  </p>
                  <p className="mt-0.5 font-semibold text-foreground">
                    {t.value}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="mx-auto max-w-page px-6 py-24 text-center">
        <h2 className="mx-auto max-w-2xl text-3xl font-bold tracking-[-0.03em] text-foreground sm:text-4xl">
          From a sentence to shippable infrastructure.
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-ink-muted">
          Start for free, no card required. Your data stays in the UK, and a
          human always holds the review gate.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button size="lg" asChild>
            <Link href="/signup">Start for free</Link>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <Link href="/pricing">See pricing</Link>
          </Button>
        </div>
      </section>
    </>
  );
}
