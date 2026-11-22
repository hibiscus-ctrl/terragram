// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";

import { Callout } from "@/components/content/callout";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Terragram handles personal data across the marketing site and the Terragram workspace, where your data is stored, and why we never train models on your designs.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <LegalShell
      current="/privacy"
      eyebrow="Legal"
      title="Privacy Policy"
      updated="9 July 2026"
      intro={
        <>
          This policy explains what personal data Terragram collects, why we process it, and the
          rights you have under UK data-protection law. It also makes plain where your data lives:
          your workspaces, models, diagrams and evidence bundles are stored in the UK.
        </>
      }
    >
      <h2 id="who-we-are">Who we are</h2>
      <p>
        Terragram is a product of <strong>Terragram Ltd</strong> (&ldquo;Terragram&rdquo;,
        &ldquo;we&rdquo;, &ldquo;us&rdquo;), a company registered in England and Wales. We are the{" "}
        <strong>data controller</strong> for the personal data described in this policy.
      </p>
      <p>
        For any privacy question, or to exercise your rights, contact our data-protection contact at{" "}
        <a href="mailto:dpo@terragram.dev">dpo@terragram.dev</a>. General privacy enquiries can also
        go to <a href="mailto:privacy@terragram.dev">privacy@terragram.dev</a>.
      </p>

      <h2 id="what-this-covers">What this policy covers</h2>
      <p>
        This policy covers our marketing site at <code>terragram.dev</code> and the{" "}
        <strong>Terragram workspace</strong>: the hosted web application where you translate between
        plain English, architecture diagrams and Terraform through one auditable internal model,
        with a human review gate and signed evidence bundles.
      </p>
      <p>
        Terragram is a hosted service; there is no software to run inside your own infrastructure.
        Where each byte of your design travels, and how we store it, is set out in our{" "}
        <Link href="/confidentiality">confidentiality commitment</Link> and the{" "}
        <Link href="/trust-center">Trust Center</Link>.
      </p>

      <h2 id="data-we-collect">Data we collect</h2>
      <p>
        For the marketing site and the workspace, we process the following categories of personal
        data:
      </p>
      <ul>
        <li>
          <strong>Account identity</strong>: when you create an account, we store your email and
          profile details in our authentication and application database (Supabase). The workspace
          is account-scoped, protected by Supabase Auth and row-level security.
        </li>
        <li>
          <strong>Workspace content</strong>: the architecture descriptions, diagrams, generated
          Terraform and evidence bundles you create, held so we can provide the service to you.
        </li>
        <li>
          <strong>Usage and metering</strong>: records of how the service is used, for example
          workspaces opened, generations run and seats in use, so we can operate, meter and bill the
          service.
        </li>
        <li>
          <strong>Billing data</strong>: if you subscribe, payment and billing details are processed
          by Stripe. We receive billing metadata (plan, status, invoices), but{" "}
          <strong>we do not store full card numbers</strong>.
        </li>
        <li>
          <strong>Support correspondence</strong>: messages you send us and the transactional email
          we send you.
        </li>
        <li>
          <strong>Analytics</strong>: aggregate usage analytics for the site and app via
          consent-gated Google Analytics (off until you accept the banner; declining sets nothing),
          plus cookieless Vercel Analytics.
        </li>
        <li>
          <strong>Technical logs</strong>: server and application logs, including IP address,
          user-agent and timestamps, generated when you interact with our hosted services.
        </li>
      </ul>

      <h2 id="why-we-process-it">Why we process it</h2>
      <p>Under UK GDPR we rely on the following legal bases:</p>
      <ul>
        <li>
          <strong>Performance of a contract</strong>: to create and run your account, provide the
          workspace, and meter and bill the service.
        </li>
        <li>
          <strong>Legitimate interests</strong>: to secure and operate our services, prevent abuse,
          keep technical logs, and understand aggregate product usage. We balance these interests
          against your rights and freedoms.
        </li>
        <li>
          <strong>Consent</strong>: for non-essential cookies and similar technologies. You can
          withdraw consent at any time (see <Link href="/cookies">Cookies</Link>).
        </li>
        <li>
          <strong>Legal obligation</strong>: to comply with tax, accounting and other legal
          requirements (for example retaining invoices).
        </li>
      </ul>

      <h2 id="your-designs">Your designs and generated code</h2>
      <p>
        Your architecture descriptions, diagrams and generated code belong to you. When you generate
        or translate, that content is processed by <strong>managed models on in-region UK endpoints
        (AWS Bedrock, UK and EU)</strong> under a data processing agreement, to produce a response.
        There is no US option and no key to manage; Enterprise plans can add BYOK or private
        endpoints for stricter isolation.
      </p>
      <p>
        <strong>We never use your designs to train models</strong>, and they are never shared with
        third parties. You can read exactly how this works in the{" "}
        <Link href="/confidentiality">Confidentiality</Link> policy and the{" "}
        <Link href="/trust-center">Trust Center</Link>.
      </p>

      <h2 id="sub-processors">Sub-processors</h2>
      <p>
        To run the workspace and our site we rely on a small set of carefully chosen processors.
        Each handles personal data only on our instructions and for the purpose shown:
      </p>
      <ul>
        <li>
          <strong>Supabase</strong>: authentication and the Postgres database holding your account
          and workspace data.
        </li>
        <li>
          <strong>Amazon Web Services</strong>: managed-model inference (AWS Bedrock, UK and EU) and
          hosting of the service.
        </li>
        <li>
          <strong>Stripe</strong>: subscription billing and payment processing (we don&rsquo;t store
          full card numbers).
        </li>
        <li>
          <strong>Email provider</strong>: transactional and support email (verification, invites,
          receipts).
        </li>
      </ul>
      <Callout tone="note" title="Keeping this list current">
        We&rsquo;ll keep this list of sub-processors up to date as our service evolves and will note
        material changes here.
      </Callout>

      <h2 id="data-residency">Data residency and international transfers</h2>
      <p>
        Terragram is <strong>UK-resident</strong>: your workspaces, models, diagrams and evidence
        bundles are stored <strong>in the UK</strong>, across <strong>UK South and UK West</strong>{" "}
        for resilience. Managed inference is European: it runs on in-region UK endpoints, with EU as
        part of the same AWS Bedrock profile. Where a transfer of personal data outside the UK or
        EEA is necessary, we rely on appropriate safeguards, such as the UK International Data
        Transfer Addendum (IDTA) or the EU Standard Contractual Clauses (SCCs), together with any
        required supplementary measures.
      </p>

      <h2 id="data-retention">Data retention</h2>
      <p>
        We keep personal data only for as long as we need it for the purposes set out above, or for
        as long as the law requires. When data is no longer needed, we delete or anonymise it.
        Indicative periods:
      </p>
      <ul>
        <li>
          <strong>Account and workspace data</strong>: for the life of your account and 12 months
          after closure.
        </li>
        <li>
          <strong>Billing records</strong>: retained for 7 years to meet tax and accounting
          obligations.
        </li>
        <li>
          <strong>Technical logs</strong>: retained for 12 months, then deleted or aggregated.
        </li>
      </ul>

      <h2 id="your-rights">Your rights</h2>
      <p>Under UK GDPR you have the right to:</p>
      <ul>
        <li>
          <strong>Access</strong>: obtain a copy of the personal data we hold about you.
        </li>
        <li>
          <strong>Rectification</strong>: have inaccurate or incomplete data corrected.
        </li>
        <li>
          <strong>Erasure</strong>: ask us to delete your data where it&rsquo;s no longer needed.
        </li>
        <li>
          <strong>Portability</strong>: receive your data in a portable, machine-readable format.
        </li>
        <li>
          <strong>Restriction</strong>: ask us to limit how we process your data.
        </li>
        <li>
          <strong>Objection</strong>: object to processing based on our legitimate interests.
        </li>
        <li>
          <strong>Withdraw consent</strong>: where we rely on consent, withdraw it at any time.
        </li>
        <li>
          <strong>Complain</strong>: lodge a complaint with the ICO at{" "}
          <a href="https://ico.org.uk" target="_blank" rel="noreferrer">
            ico.org.uk
          </a>
          . We&rsquo;d appreciate the chance to resolve things first; please reach us at{" "}
          <a href="mailto:dpo@terragram.dev">dpo@terragram.dev</a>.
        </li>
      </ul>

      <h2 id="cookies">Cookies</h2>
      <p>
        We use a small number of essential cookies plus, with your consent, privacy-friendly
        analytics. For the full breakdown and how to manage your choices, see our{" "}
        <Link href="/cookies">Cookie Policy</Link>.
      </p>

      <h2 id="security">Security</h2>
      <p>
        We take a security-first approach to building Terragram: workspaces are account-scoped with
        row-level security, git connections use short-lived scoped tokens, and nothing becomes code
        without passing the human review gate. For how the workspace is designed to protect your
        data, read the <Link href="/trust-center">Trust Center</Link>. To report a vulnerability,
        email <a href="mailto:security@terragram.dev">security@terragram.dev</a>.
      </p>

      <h2 id="children">Children</h2>
      <p>
        Terragram is a tool for software and infrastructure teams. It is not directed at children,
        and we do not knowingly collect personal data from anyone under 16. If you believe a child
        has provided us with personal data, contact{" "}
        <a href="mailto:privacy@terragram.dev">privacy@terragram.dev</a> and we will delete it.
      </p>

      <h2 id="changes">Changes to this policy</h2>
      <p>
        We may update this policy from time to time. When we do, we&rsquo;ll post the revised
        version here and update the &ldquo;last updated&rdquo; date at the top of the page. For
        material changes, we&rsquo;ll take reasonable steps to let you know.
      </p>

      <h2 id="contact">Contact us</h2>
      <p>
        Questions about this policy or your personal data? Email{" "}
        <a href="mailto:privacy@terragram.dev">privacy@terragram.dev</a>, or contact our
        data-protection contact directly at <a href="mailto:dpo@terragram.dev">dpo@terragram.dev</a>
        . You can also reach the team via the <Link href="/contact">contact page</Link>.
      </p>
    </LegalShell>
  );
}
