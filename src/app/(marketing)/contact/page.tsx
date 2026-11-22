// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { Mail, LifeBuoy, ShieldCheck, Building2 } from "lucide-react";

import { GITHUB_REPO_URL, hasPublicRepo, repoFileUrl } from "@/config/company";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Reach the Terragram team: general questions, product support, responsible disclosure, and sales or Enterprise enquiries.",
  alternates: { canonical: "/contact" },
};

export default function ContactPage() {
  return (
    <LegalShell
      current="/contact"
      eyebrow="Support"
      title="Contact us"
      intro={
        <>
          We&rsquo;re a small, security-minded team and we read every message. Pick the
          channel below that fits, and we&rsquo;ll get back to you.
        </>
      }
    >
      <p>
        There&rsquo;s no contact form to fill in here: just direct channels that reach a real
        person. Email is usually fastest, but if you live in pull requests, GitHub works too.
      </p>

      <div className="my-7 grid gap-4 sm:grid-cols-2">
        <div className="border-border bg-card rounded-xl border p-5">
          <span className="text-primary bg-surface-sunken mb-3 flex size-9 items-center justify-center rounded-lg">
            <Mail className="size-4" strokeWidth={1.7} aria-hidden />
          </span>
          <p className="font-bold text-foreground">General</p>
          <p className="text-muted-foreground mt-1 text-xs">Questions, feedback, anything else.</p>
          <a
            href="mailto:hello@terragram.dev"
            className="text-primary mt-2 inline-block text-xs font-semibold hover:underline"
          >
            hello@terragram.dev
          </a>
        </div>

        <div className="border-border bg-card rounded-xl border p-5">
          <span className="text-primary bg-surface-sunken mb-3 flex size-9 items-center justify-center rounded-lg">
            <LifeBuoy className="size-4" strokeWidth={1.7} aria-hidden />
          </span>
          <p className="font-bold text-foreground">Product support</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Help getting set up or running Terragram.
          </p>
          <a
            href="mailto:support@terragram.dev"
            className="text-primary mt-2 inline-block text-xs font-semibold hover:underline"
          >
            support@terragram.dev
          </a>
          <p className="text-muted-foreground mt-2 text-xs">
            Or browse the <Link href="/help">help centre</Link> and <Link href="/faq">FAQ</Link>{" "}
            first: the answer may already be there.
          </p>
        </div>

        <div className="border-border bg-card rounded-xl border p-5">
          <span className="text-primary bg-surface-sunken mb-3 flex size-9 items-center justify-center rounded-lg">
            <ShieldCheck className="size-4" strokeWidth={1.7} aria-hidden />
          </span>
          <p className="font-bold text-foreground">Security</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Report a vulnerability (responsible disclosure).
          </p>
          <a
            href="mailto:security@terragram.dev"
            className="text-primary mt-2 inline-block text-xs font-semibold hover:underline"
          >
            security@terragram.dev
          </a>
          <p className="text-muted-foreground mt-2 text-xs">
            Our contact details are also published in{" "}
            {/* oxlint-disable-next-line no-html-link-for-pages -- a static file under public/.well-known, not a Next page. */}
            <a href="/.well-known/security.txt">security.txt</a> (RFC 9116)
            {hasPublicRepo() && (
              <>
                , and the full policy lives in{" "}
                <a href={repoFileUrl("SECURITY.md")} target="_blank" rel="noreferrer">
                  SECURITY.md
                </a>
              </>
            )}
            .
          </p>
        </div>

        <div className="border-border bg-card rounded-xl border p-5">
          <span className="text-primary bg-surface-sunken mb-3 flex size-9 items-center justify-center rounded-lg">
            <Building2 className="size-4" strokeWidth={1.7} aria-hidden />
          </span>
          <p className="font-bold text-foreground">Sales &amp; Enterprise</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Dedicated instance, SSO, DPA and residency questions.
          </p>
          <p className="text-muted-foreground mt-2 text-xs">
            <Link href="/pricing">See pricing</Link>, then reach us at{" "}
            <a
              href="mailto:hello@terragram.dev"
              className="text-primary font-semibold hover:underline"
            >
              hello@terragram.dev
            </a>
            .
          </p>
        </div>
      </div>

      {hasPublicRepo() && (
        <>
          <h2 id="prefer-github">Prefer GitHub?</h2>
          <p>
            If you&rsquo;d rather file something in the open, open an issue on{" "}
            <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
            : bug reports, feature requests, and questions are all welcome there.
          </p>
        </>
      )}

      <h2 id="response-times">Response times</h2>
      <p>
        We aim to reply within <strong>1&ndash;2 business days</strong>. Security reports are
        triaged faster. If you don&rsquo;t hear back on a disclosure, email us again.
      </p>
    </LegalShell>
  );
}
