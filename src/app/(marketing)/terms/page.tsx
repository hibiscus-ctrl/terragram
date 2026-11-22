// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";

import { LegalShell } from "@/components/legal/legal-shell";
import { entryRatePence, formatGbp } from "@/config/pricing";

export const metadata: Metadata = {
  title: "Terms & Conditions",
  description:
    "The agreement that governs your use of the Terragram site and the Terragram workspace: what you can expect from us, and what we ask of you.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <LegalShell
      current="/terms"
      eyebrow="Legal"
      title="Terms & Conditions"
      updated="22 November 2026"
      intro={
        <>
          These terms set out the agreement between you and Terragram Ltd for the Terragram website
          and the Terragram workspace.
        </>
      }
    >
      <h2 id="acceptance">1. Acceptance</h2>
      <p>
        By accessing the Terragram website or by registering for and using the Terragram workspace,
        you agree to be bound by these Terms &amp; Conditions. If you do not agree, please do not use
        the Service. If you are using the Service on behalf of an organisation, you confirm that you
        have the authority to bind that organisation to these terms, and &ldquo;you&rdquo; refers to
        that organisation. You must be at least 16 years old to use the Service.
      </p>

      <h2 id="definitions">2. Definitions</h2>
      <ul>
        <li>
          <strong>the Service</strong>: the Terragram website at terragram.dev together with the
          Terragram workspace, taken collectively.
        </li>
        <li>
          <strong>the workspace</strong>: the hosted web application that translates between plain
          English, architecture diagrams and Terraform through one auditable internal model, with a
          human review gate and signed evidence bundles.
        </li>
        <li>
          <strong>You / User</strong>: the individual or organisation that accesses the website or
          holds a Terragram account.
        </li>
      </ul>

      <h2 id="the-service">3. The Service</h2>
      <p>
        Terragram is a hosted workspace. You create an account, describe the infrastructure you
        need or draw it as a diagram, and Terragram translates between plain English, diagrams and
        Terraform through one internal model. Nothing becomes code until a human approves the model
        through the <Link href="/docs/review-gate">review gate</Link>, and every generation ships
        with a signed evidence bundle (SBOM and plan) you can verify. Your workspaces, models,
        diagrams and evidence bundles are stored in the UK; managed inference runs on in-region UK
        endpoints (AWS Bedrock, UK and EU).
      </p>

      <h2 id="acceptable-use">4. Acceptable use</h2>
      <p>When using the Service you agree that you will not:</p>
      <ul>
        <li>upload, store or transmit any unlawful, infringing or malicious content;</li>
        <li>
          abuse, overload, disrupt or otherwise interfere with the Service or its infrastructure;
        </li>
        <li>
          attempt to breach the security of the Service, or probe or scan it for vulnerabilities
          outside our responsible disclosure process;
        </li>
        <li>
          access or extract data from the Service by scraping, crawling or other automated means,
          other than through our published APIs and integrations;
        </li>
        <li>use another person&rsquo;s account, or share your own credentials, without permission;</li>
        <li>
          circumvent or attempt to circumvent any authentication, scoping or access control; or
        </li>
        <li>exceed published rate limits or otherwise act outside reasonable fair use.</li>
      </ul>

      <h2 id="your-responsibilities">5. Your responsibilities</h2>
      <ul>
        <li>
          <strong>You review and merge every change.</strong> Terragram never applies infrastructure
          and never auto-merges. When you choose to open a pull request with generated Terraform, it
          uses short-lived, scoped tokens for just those repositories; <strong>you</strong> review,
          approve and merge each change, and you remain responsible for whatever you choose to merge.
        </li>
        <li>
          <strong>Git access.</strong> You keep any GitHub or GitLab connection scoped appropriately
          to the repositories you open pull requests into, and you are responsible for the accounts
          and permissions of people in your organisation.
        </li>
        <li>
          <strong>Your cloud accounts.</strong> You are responsible for the cloud accounts your
          Terraform targets, and for validating and testing generated code before you apply it.
        </li>
      </ul>

      <h2 id="generated-code-no-warranty">6. Generated code: no warranty</h2>
      <p>
        Terragram&rsquo;s generated Terraform is a <em>draft</em>, delivered for human review. It is
        provided <strong>&ldquo;as is&rdquo;</strong>, without warranty that any given output is
        complete, correct for your context, or fit for a particular purpose. The signed evidence
        bundle (SBOM and plan) records what was generated and lets you verify it after the fact, but
        it does not relieve you of the duty to validate, test and merge the change yourself.
      </p>

      <h2 id="plans-billing">7. Plans &amp; billing</h2>
      <p>Terragram is offered on the following tiers:</p>
      <ul>
        <li>
          <strong>Community</strong>: free for the public sector, charities and learners. Unlimited
          diagrams, chat and diagram modes, and managed UK inference.
        </li>
        <li>
          <strong>Team</strong>: from {formatGbp(entryRatePence())} per seat per month (volume
          bands reduce the rate — see <Link href="/pricing">pricing</Link>), adding Terraform and
          OpenTofu output, the review gate and signed evidence, GitHub and GitLab pull requests,
          and priority support.
        </li>
        <li>
          <strong>Enterprise</strong>: custom pricing for BYOK and private endpoints, SSO/SAML
          sign-in, audit-log export and an SLA, with procurement via G-Cloud.
        </li>
      </ul>
      <p>
        Paid plans are billed through <strong>Stripe</strong>, our payment processor. Subscriptions
        renew automatically for the billing period you selected unless you cancel before the renewal
        date; you can cancel at any time, effective at the end of the current period. Because you can
        cancel at any time, with your plan then ending at the close of the current billing period, we
        do not generally refund fees for a period already started. If you believe you have been
        charged in error, email <a href="mailto:support@terragram.dev">support@terragram.dev</a>{" "}
        within 30 days and we will put it right. This does not affect any statutory rights you may
        have. Current pricing is on the <Link href="/pricing">pricing page</Link>.
      </p>

      <h2 id="intellectual-property">8. Intellectual property</h2>
      <p>
        We own the Terragram name, logo and marks, and we (or our licensors) own the website and the
        Terragram workspace software. The source code is available under the AGPL-3.0-only licence,
        and that licence, not these terms, governs your use of the code; these terms govern only
        your use of the hosted Service. The licence does not grant any right to our name, logo or
        marks. You retain ownership of your own architecture descriptions,
        diagrams, code, and any Terraform generated for you by the Service. We claim no ownership
        over your content, and <strong>we never use your designs to train models</strong>; you
        simply grant us the limited rights needed to operate the Service for you.
      </p>

      <h2 id="third-party-services">9. Third-party services</h2>
      <p>
        The Service depends on third parties, including any git provider you connect and the cloud
        providers your Terraform targets. Your use of those services is governed by their own terms
        and policies, and we are not responsible for them. You are responsible for maintaining your
        relationships and complying with the terms of any third party you connect to Terragram.
      </p>

      <h2 id="confidentiality">10. Confidentiality</h2>
      <p>
        How we treat your designs and confidential data is set out separately in our{" "}
        <Link href="/confidentiality">Confidentiality statement</Link>, which forms part of these
        terms.
      </p>

      <h2 id="disclaimers-liability">11. Disclaimers &amp; liability</h2>
      <p>
        The Service is provided <strong>&ldquo;as is&rdquo;</strong> and{" "}
        <strong>&ldquo;as available&rdquo;</strong>, without warranties of any kind, whether express
        or implied, to the maximum extent permitted by law. To the extent permitted by law, we
        exclude all liability for indirect, incidental, special or consequential loss, and for loss
        of profits, revenue, data or goodwill. Nothing in these terms excludes or limits liability
        that cannot lawfully be excluded. Subject to the foregoing, our total aggregate liability
        arising out of or in connection with the Service is capped at the total fees you paid to us
        for the Service in the 12 months immediately before the event giving rise to the claim.
      </p>

      <h2 id="indemnity">12. Indemnity</h2>
      <p>
        You agree to indemnify and hold Terragram Ltd harmless from any claims, losses, liabilities
        and reasonable expenses arising out of your misuse of the Service, your breach of these
        terms, or content you submit through the Service, to the extent permitted by law.
      </p>

      <h2 id="termination">13. Termination</h2>
      <p>
        You may stop using the Service at any time, and you can close your Terragram account whenever
        you choose. We may suspend or terminate your access if you materially breach these terms or
        use the Service in a way that risks harm to it or to other users. On termination, the rights
        granted to you under these terms end, while any terms that by their nature should survive
        (such as intellectual property, disclaimers, liability and governing law) continue to apply.
      </p>

      <h2 id="changes">14. Changes to these terms</h2>
      <p>
        We may update these terms from time to time. When we do, we will revise the &ldquo;last
        updated&rdquo; date shown at the top of this page. Significant changes will be communicated
        where appropriate, and your continued use of the Service after a change takes effect means
        you accept the updated terms.
      </p>

      <h2 id="governing-law">15. Governing law</h2>
      <p>
        These terms are governed by the laws of <strong>England &amp; Wales</strong>, and you and we
        agree that the courts of England &amp; Wales have exclusive jurisdiction over any dispute
        arising out of or in connection with them.
      </p>

      <h2 id="contact">16. Contact</h2>
      <p>
        Questions about these terms? Email us at{" "}
        <a href="mailto:hello@terragram.dev">hello@terragram.dev</a>, or reach support at{" "}
        <a href="mailto:support@terragram.dev">support@terragram.dev</a>. Terragram Ltd is a company
        registered in England &amp; Wales.
      </p>
    </LegalShell>
  );
}
