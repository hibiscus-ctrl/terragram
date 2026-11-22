import type { Metadata } from "next";
import Link from "next/link";

import { Callout } from "@/components/content/callout";
import { hasPublicRepo, repoFileUrl } from "@/config/company";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
  title: "Trust Center",
  description:
    "Terragram's security posture: the human review gate and signed evidence, UK data residency, least-privilege access, the compliance frameworks we help you evidence, our certification roadmap, and how to report a vulnerability.",
  alternates: { canonical: "/trust-center" },
};

export default function TrustCenterPage() {
  return (
    <LegalShell
      current="/trust-center"
      eyebrow="Trust"
      title="Trust Center"
      updated="9 July 2026"
      intro={
        <>
          Terragram builds infrastructure for teams who answer to auditors, so we hold ourselves to
          the same bar. Here&rsquo;s our security posture in one place: what we do today, and what
          we&rsquo;re working toward.
        </>
      }
    >
      <Callout tone="safe" title="Evidence, not assertions">
        Terragram&rsquo;s core trust claim is the <strong>review gate</strong>: nothing becomes code
        until a human approves the model, and every generation ships with a{" "}
        <strong>signed SBOM and plan</strong> anyone can verify after the fact. We never apply
        infrastructure; approved output opens a pull request that <em>you</em> merge.
      </Callout>

      <h2 id="certifications">Certifications &amp; attestations</h2>
      <p>
        We&rsquo;re building toward formal third-party attestation. To be precise about where we are
        today, because a Trust Center that overstates is worse than none:
      </p>
      <ul>
        <li>
          <strong>SOC 2 (Type II)</strong>: <em>in progress.</em> We are implementing the
          controls and the evidence pipeline; the Type II observation window and the independent
          audit are the remaining steps. We will publish the report here (under NDA) once the audit
          completes. <em>No SOC 2 report exists yet, do not rely on one.</em>
        </li>
        <li>
          <strong>ISO 27001</strong>: we run our own estate against the ISO 27001 control set
          as an internal control. Formal certification is on the same roadmap as SOC 2.
        </li>
        <li>
          <strong>UK Cyber Essentials</strong>: a framework we design output to evidence; we
          hold our own estate to it.
        </li>
      </ul>
      <p>
        Need our current control status or a security questionnaire answered before that?{" "}
        <Link href="/contact">Contact us</Link>, we&rsquo;ll share where each control stands.
      </p>

      <h2 id="data-residency">Data residency &amp; sovereignty</h2>
      <p>
        Terragram is <strong>UK-resident</strong>: your workspaces, models, diagrams and evidence
        bundles are stored <strong>in the UK</strong>, across <strong>UK South and UK West</strong>{" "}
        for resilience. Managed inference runs on <strong>in-region UK endpoints</strong>, so your
        architecture descriptions and diagrams are processed in the UK, with no US option and no key
        to manage.
      </p>
      <p>
        Your architecture descriptions, diagrams and generated code belong to you. We{" "}
        <strong>never use your designs to train models</strong>, and they are never shared with third
        parties. Enterprise plans can add <strong>BYOK and private endpoints</strong> for stricter
        isolation. The full detail is on the{" "}
        <Link href="/docs/residency">data residency</Link> page and in the{" "}
        <Link href="/confidentiality">Confidentiality</Link> policy.
      </p>

      <h2 id="access">Least-privilege access</h2>
      <p>Access is narrow by construction and enforced in code, not policy alone:</p>
      <ul>
        <li>
          Workspace data is scoped to your account; the app is protected by Supabase Auth and
          row-level security.
        </li>
        <li>
          Git connections use <strong>short-lived, scoped tokens</strong> for the repositories you
          open pull requests into, no long-lived, broad credentials.
        </li>
        <li>
          Internal access to customer data is need-to-know and logged to an append-only audit log.
        </li>
      </ul>

      <h2 id="application-security">Application &amp; supply-chain security</h2>
      <ul>
        <li>Webhook payloads are signature-verified; API tokens are stored hashed.</li>
        <li>
          Our own CI runs typecheck, lint, tests and build on every change, with a{" "}
          <strong>
            least-privilege <code>GITHUB_TOKEN</code>
          </strong>{" "}
          and third-party actions <strong>pinned to commit SHAs</strong>.
        </li>
        <li>Dependencies are updated on a grouped weekly cadence (Dependabot).</li>
      </ul>

      <h2 id="compliance-mapping">Compliance &amp; procurement</h2>
      <p>
        Terragram generates infrastructure designed to stand up to UK governance and procurement
        review, and every generation ships with a signed evidence bundle you can hand to an auditor.
        Enterprise is available <strong>via G-Cloud</strong>, with SSO/SAML sign-in, audit-log
        export and an SLA. See <Link href="/pricing">pricing</Link> or{" "}
        <Link href="/contact">get in touch</Link> for a security questionnaire.
      </p>

      <h2 id="disclosure">Vulnerability disclosure</h2>
      <p>
        Found something? Report it to{" "}
        <a href="mailto:security@terragram.dev">security@terragram.dev</a>, the address in our
        {/* oxlint-disable-next-line no-html-link-for-pages -- a static file under public/.well-known, not a Next page. */}
        machine-readable <a href="/.well-known/security.txt">security.txt</a> (RFC 9116)
        {hasPublicRepo() && (
          <>
            . The policy and safe-harbour terms live in{" "}
            <a href={repoFileUrl("SECURITY.md")} target="_blank" rel="noreferrer">
              SECURITY.md
            </a>
          </>
        )}
        . We read and act on every report.
      </p>

      <h2 id="agreements">Data processing &amp; agreements</h2>
      <p>
        A <strong>Data Processing Agreement</strong> is available for Team and Enterprise plans, and
        our sub-processors are listed in the <Link href="/privacy">Privacy policy</Link>. To put a
        DPA or NDA in place, <Link href="/contact">get in touch</Link>.
      </p>
    </LegalShell>
  );
}
