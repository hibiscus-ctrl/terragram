import type { Metadata } from "next";
import Link from "next/link";

import { Callout } from "@/components/content/callout";
import { hasPublicRepo, repoFileUrl } from "@/config/company";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
  title: "Confidentiality",
  description:
    "Exactly what Terragram stores of your designs and code, where it lives, and why we never train models on your work or share it with third parties.",
  alternates: { canonical: "/confidentiality" },
};

export default function ConfidentialityPage() {
  return (
    <LegalShell
      current="/confidentiality"
      eyebrow="Trust"
      title="Confidentiality"
      updated="9 July 2026"
      intro={
        <>
          Terragram is where your architecture becomes Terraform, so your designs are the most
          sensitive thing you trust us with. Here&rsquo;s precisely what we store, where it lives,
          and what we never do with it.
        </>
      }
    >
      <Callout tone="safe" title="Your designs stay yours">
        Your architecture descriptions, diagrams and generated code belong to you. We never use them
        to train models, and they are never shared with third parties.
      </Callout>

      <h2 id="what-stays-with-you">What we hold, and where it lives</h2>
      <p>
        Terragram is a hosted workspace, so your architecture descriptions, diagrams, generated
        Terraform and evidence bundles are stored in it to provide the service to you. That data is{" "}
        <strong>resident in the UK</strong>, across <strong>UK South and UK West</strong> for
        resilience. Nothing about your designs leaves the UK for storage.
      </p>
      <p>
        If you want the full picture of where each byte travels, read the{" "}
        <Link href="/trust-center">Trust Center</Link> and the{" "}
        <Link href="/docs/residency">data residency</Link> page.
      </p>

      <h2 id="inference">How inference is handled</h2>
      <p>
        When you generate or translate, your architecture descriptions and diagrams are processed by{" "}
        <strong>managed models on in-region UK endpoints (AWS Bedrock, UK and EU)</strong> under a
        data processing agreement. There is <strong>no US option and no key to manage</strong>.
        Inference is European: it runs in the UK, with EU as part of the same Bedrock profile.
      </p>
      <p>
        <strong>We never train models on your designs</strong>, and your designs and code are never
        shared with third parties. Enterprise plans can add <strong>BYOK or private endpoints</strong>{" "}
        for stricter isolation, so where your prompts go, and the residency of anything you send
        them, is yours to govern.
      </p>

      <h2 id="review-gate">Nothing lands without your review</h2>
      <p>
        Terragram never applies infrastructure and never auto-merges. Nothing becomes code until a
        human approves the model through the <Link href="/docs/review-gate">review gate</Link>, and
        every generation ships with a <strong>signed evidence bundle (SBOM and plan)</strong> you can
        verify. When you choose to open a pull request with generated Terraform, Terragram uses{" "}
        <strong>short-lived, scoped tokens</strong> for just those repositories; you review and merge
        each change yourself.
      </p>

      <h2 id="least-privilege">Least-privilege by construction</h2>
      <p>
        The access Terragram holds is deliberately narrow, and the narrowness is enforced in code,
        not by policy alone:
      </p>
      <ul>
        <li>
          Workspace data is <strong>scoped to your account</strong>, protected by Supabase Auth and
          row-level security.
        </li>
        <li>
          Git connections use <strong>short-lived, scoped tokens</strong> for the repositories you
          open pull requests into; there are no long-lived, broad credentials.
        </li>
        <li>
          Internal access to customer data is <strong>need-to-know</strong> and logged to an
          append-only audit log.
        </li>
      </ul>
      <p>
        These boundaries are documented in the <Link href="/trust-center">Trust Center</Link>.
      </p>

      <h2 id="our-team-access">Our team&rsquo;s access</h2>
      <p>
        Access to any workspace data is on a <strong>need-to-know</strong> basis and is logged. Only
        the people who need it to operate or support the service can reach it, and access is recorded
        for review.
      </p>

      <h2 id="sub-processors-and-dpa">Sub-processors and DPA</h2>
      <p>
        We rely on a small set of vetted sub-processors to run the service; who they are and what
        they handle is set out in our <Link href="/privacy">Privacy policy</Link>. For Team and
        Enterprise plans a <strong>Data Processing Agreement</strong> is available;{" "}
        <Link href="/contact">contact us</Link> to put one in place.
      </p>

      <h2 id="responsible-disclosure">Responsible disclosure</h2>
      <p>
        Found a vulnerability? Report it to{" "}
        <a href="mailto:security@terragram.dev">security@terragram.dev</a>, the address published
        {/* oxlint-disable-next-line no-html-link-for-pages -- a static file under public/.well-known, not a Next page. */}
        in our <a href="/.well-known/security.txt">security.txt</a> (RFC 9116)
        {hasPublicRepo() && (
          <>
            . How to disclose safely is set out in{" "}
            <a href={repoFileUrl("SECURITY.md")} target="_blank" rel="noreferrer">
              SECURITY.md
            </a>
          </>
        )}
        . We read and act on every report.
      </p>

      <h2 id="formal-agreements">Formal agreements</h2>
      <p>
        For contractual confidentiality, an NDA or DPA governs the relationship: the page
        you&rsquo;re reading describes our practice, but the binding obligations live in the
        agreement we sign with you. See our <Link href="/terms">Terms</Link>, then{" "}
        <Link href="/contact">get in touch</Link> to arrange the paperwork.
      </p>

      <h2 id="contact">Contact</h2>
      <p>
        Security questions go to <a href="mailto:security@terragram.dev">security@terragram.dev</a>.
        Data and privacy questions go to{" "}
        <a href="mailto:privacy@terragram.dev">privacy@terragram.dev</a>. For the binding legal
        terms, see our <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy</Link>.
      </p>
    </LegalShell>
  );
}
