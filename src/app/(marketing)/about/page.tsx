// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";

import { Callout } from "@/components/content/callout";
import { LegalShell } from "@/components/legal/legal-shell";
import {
  COMPANY,
  FOUNDERS,
  GITHUB_REPO_URL,
  hasCompanyDetails,
  hasFounders,
  hasPublicRepo,
} from "@/config/company";

export const metadata: Metadata = {
  title: "About",
  description:
    "Terragram began inside NHS platform teams who spent more time writing Terraform than deciding what to build. We translate between plain English, diagrams and Terraform, in any direction, through one auditable model.",
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <LegalShell
      current="/about"
      eyebrow="Company"
      title="About Terragram"
      intro={
        <>
          We think infrastructure should be something anyone can describe, and something a reviewer
          can trust. Terragram closes the gap between an idea, a diagram, and compliant, auditable
          code, in any direction.
        </>
      }
    >
      <h2 id="why">Why we built it</h2>
      <p>
        Terragram began inside NHS platform teams who were spending more time writing Terraform than
        deciding what to build. The people who best understood the service they needed, clinicians,
        delivery managers, small in-house teams, were the furthest from the tooling that could ship
        it. The gap between an idea and compliant, auditable infrastructure was measured in weeks and
        specialist hires.
      </p>
      <p>
        So we built a translator. You describe what you need in plain English, or sketch it, or hand
        us existing Terraform, and Terragram keeps the words, the diagram, and the code as three
        views of <strong>one internal model</strong> that never drift apart. Nothing becomes code
        until a human approves the model at the review gate, and every generation ships with a signed
        evidence bundle an auditor will accept.
      </p>

      <h2 id="how">How it works</h2>
      <p>Four modes, one model:</p>
      <ul>
        <li>
          <strong>Chat to Diagram</strong>: describe your architecture and watch the diagram build
          itself.
        </li>
        <li>
          <strong>Chat to Terraform</strong>: describe it in plain English and get review-ready
          Terraform.
        </li>
        <li>
          <strong>Diagram to Terraform</strong>: draw it on the canvas and generate
          compliant IaC.
        </li>
        <li>
          <strong>Terraform to Diagram</strong>: paste existing Terraform and reverse-engineer the
          diagram to keep your docs honest.
        </li>
      </ul>
      <p>
        The detail lives in the <Link href="/docs">documentation</Link>. Start with the{" "}
        <Link href="/docs/quickstart">quickstart</Link> or read about{" "}
        <Link href="/docs/review-gate">the review gate</Link>.
      </p>

      <h2 id="believe">What we believe</h2>
      <p>Three principles decide the arguments:</p>
      <ul>
        <li>
          <strong>Trust over cleverness.</strong> A tool architects can defend in an audit beats a
          clever one they can&rsquo;t. Every output is explainable and signed.
        </li>
        <li>
          <strong>Plain language first.</strong> The barrier to good infrastructure shouldn&rsquo;t
          be knowing the vocabulary. We translate, so you can focus on intent.
        </li>
        <li>
          <strong>Open by default.</strong> Free for public good, standards-based output, and
          diagrams you can take anywhere. No lock-in.
        </li>
      </ul>

      <h2 id="residency">Built for the UK, open to everyone</h2>
      <p>
        Terragram is built for the UK public sector first: NHS trusts, central and local government,
        universities and charities. Your data stays in the UK (UK South / UK West), and inference
        runs on managed, in-region endpoints. Everyone else is welcome on the same terms.
      </p>

      <Callout tone="safe" title="The promises we hold ourselves to">
        <ul className="mt-1 mb-0">
          <li>A human always approves the model at the review gate before code is generated.</li>
          <li>Every generation ships with a signed SBOM and plan you can verify.</li>
          <li>Your architecture descriptions, diagrams and code are never used to train models.</li>
          <li>Data stays in the UK; inference runs on managed UK endpoints.</li>
        </ul>
      </Callout>

      {hasFounders() && (
        <>
          <h2 id="founder">Who&rsquo;s behind Terragram</h2>
          {FOUNDERS.filter((f) => f.name.trim()).map((f) => (
            <p key={f.name}>
              <strong>{f.name}</strong>
              {f.role ? `, ${f.role}` : ""}.{f.bio ? ` ${f.bio}` : ""}
            </p>
          ))}
        </>
      )}

      {hasCompanyDetails() && (
        <>
          <h2 id="company-details">Company details</h2>
          <p>
            Terragram is operated by <strong>{COMPANY.legalName}</strong>
            {COMPANY.companyNumber ? (
              <>
                , a company registered in {COMPANY.jurisdiction} (company no.{" "}
                {COMPANY.companyNumber})
              </>
            ) : null}
            .
          </p>
          {(COMPANY.registeredOffice || COMPANY.vatNumber) && (
            <ul>
              {COMPANY.registeredOffice ? (
                <li>Registered office: {COMPANY.registeredOffice}</li>
              ) : null}
              {COMPANY.vatNumber ? <li>VAT number: {COMPANY.vatNumber}</li> : null}
            </ul>
          )}
        </>
      )}

      <h2 id="contact">Talk to us</h2>
      <p>
        Terragram is built by a small, security-minded team. We read every message, whether
        it&rsquo;s a bug, a compliance question, or a &ldquo;does it handle <em>this</em>{" "}
        shape?&rdquo; Reach us via the <Link href="/contact">contact page</Link> or browse the{" "}
        <Link href="/help">help centre</Link>
        {hasPublicRepo() && (
          <>
            , or open an issue on{" "}
            <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </>
        )}
        .
      </p>
    </LegalShell>
  );
}
