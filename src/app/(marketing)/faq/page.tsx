import type { Metadata } from "next";
import Link from "next/link";

import { LegalShell } from "@/components/legal/legal-shell";
import { JsonLd } from "@/components/seo/json-ld";
import { faqSchema } from "@/config/structured-data";

export const metadata: Metadata = {
  title: "FAQ",
  description:
    "Answers to the questions teams ask most about Terragram: the four modes, the review gate, where your data lives, pricing and procurement.",
  alternates: { canonical: "/faq" },
};

type FaqItem = { question: string; answer: string };

const USING: FaqItem[] = [
  {
    question: "Do I need to know Terraform to use Terragram?",
    answer:
      "No. Describe what you need in plain English, or sketch it as a diagram, and Terragram writes review-ready Terraform for you. Because the code is right there next to your words and your diagram, it is also one of the clearest ways to learn Terraform.",
  },
  {
    question: "What are the four modes?",
    answer:
      "Chat to Diagram, Chat to Terraform, Diagram to Terraform, and Terraform to Diagram. You can switch between them at any time, because all four run through one internal model that keeps your words, your diagram and your code in sync.",
  },
  {
    question: "Which clouds can it target?",
    answer:
      "AWS or Azure, from the same model. You pick the target when you review the model, so the same description can produce Terraform for either cloud.",
  },
  {
    question: "Can I bring my own diagrams or existing Terraform?",
    answer:
      "Yes. Upload a screenshot or photo of a diagram and managed UK inference reads the boxes and arrows into a model; paste a Mermaid flowchart and it is read with no inference at all. Either way each box becomes a component by its label and each arrow a connection you own; anything it cannot match is flagged rather than dropped. Paste or open existing Terraform and Terragram reverse-engineers the diagram from it, reading the resources, their settings and the references between them.",
  },
  {
    question: "Does Terragram deploy or change my infrastructure?",
    answer:
      "No. Terragram produces Terraform or OpenTofu plus a signed evidence bundle. A human approves the model at the review gate and merges the pull request; Terragram never applies infrastructure itself.",
  },
];

const TRUST: FaqItem[] = [
  {
    question: "What is the review gate?",
    answer:
      "Before any code is generated, a human reviews the model and resolves anything the AI flagged as uncertain. Once approved, you get a signed SBOM and plan as evidence, so the decision is provable after the fact.",
  },
  {
    question: "Where does my data live?",
    answer:
      "In the UK: UK South and UK West. Inference runs on managed, in-region endpoints. Your architecture descriptions, diagrams and generated code are never used to train models and are never shared with third parties.",
  },
  {
    question: "Is it really free for the public sector?",
    answer:
      "The Community tier is free and includes unlimited diagrams and the chat and diagram modes, with managed UK inference available as a metered add-on. Teams that need Terraform output, the review gate and signed evidence pay per seat on the Team tier.",
  },
  {
    question: "How do we buy it through procurement?",
    answer:
      "Enterprise is available via G-Cloud and adds BYOK and private endpoints, SSO/SAML sign-in, audit-log export, a 99.9% SLA and a dedicated success manager.",
  },
  {
    question: "Is Terragram open and accessible?",
    answer:
      "Output is standards-based — Terraform or OpenTofu code, SVG diagrams and a signed evidence bundle you can verify without us — so there is no lock-in. The product is built to be keyboard and screen-reader ready.",
  },
];

const ALL = [...USING, ...TRUST];

function Faq({ items }: { items: FaqItem[] }) {
  return (
    <div className="my-7 flex flex-col gap-3">
      {items.map((item) => (
        <details
          key={item.question}
          className="group rounded-xl border border-border bg-card px-5 py-1 [&_a]:text-primary"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-sm font-semibold text-foreground marker:hidden">
            <span>{item.question}</span>
            <svg
              className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </summary>
          <div className="pb-4 text-sm leading-[1.6] text-ink-muted">
            <p>{item.answer}</p>
          </div>
        </details>
      ))}
    </div>
  );
}

export default function FaqPage() {
  return (
    <LegalShell
      current="/faq"
      eyebrow="Support"
      title="Frequently asked questions"
      intro={
        <>
          The short answers to what teams ask most before they bring Terragram into their workflow,
          from the four modes to where your data lives.
        </>
      }
    >
      <JsonLd data={faqSchema(ALL)} />

      <h2 id="using-terragram">Using Terragram</h2>
      <Faq items={USING} />

      <h2 id="trust-and-pricing">Trust, data &amp; pricing</h2>
      <Faq items={TRUST} />

      <h2 id="still-stuck">Still have a question?</h2>
      <p>
        If your question isn&rsquo;t here, browse the <Link href="/help">help centre</Link> or{" "}
        <Link href="/contact">contact us</Link>. We read every message.
      </p>
    </LegalShell>
  );
}
