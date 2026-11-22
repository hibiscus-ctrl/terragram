import type { Metadata } from "next";
import Link from "next/link";

import { Callout } from "@/components/content/callout";
import { DocArticle } from "@/components/docs/doc-article";

export const metadata: Metadata = {
  title: "Quickstart",
  description: "Open a workspace, describe what you need, and get Terraform in a few minutes.",
  alternates: { canonical: "/docs/quickstart" },
};

export default function QuickstartDoc() {
  return (
    <DocArticle
      current="/docs/quickstart"
      title="Quickstart"
      description="From a sentence to review-ready Terraform in a few minutes. This walks through a first workspace end to end: describe, review, generate."
    >
      <h2 id="open">1. Open a workspace</h2>
      <p>
        Sign in and start a new workspace. Terragram asks what you want to translate and offers the{" "}
        <Link href="/docs/modes">four modes</Link>. For a first run, pick <strong>Chat to Diagram</strong>{" "}
        or <strong>Chat to Terraform</strong>.
      </p>

      <h2 id="describe">2. Describe your architecture</h2>
      <p>
        Type what you need in plain English, the way you would explain it to a colleague. For
        example: &ldquo;A public API behind a load balancer, an app running in containers, and a
        managed Postgres database, all private except the load balancer.&rdquo; Terragram drafts the
        model node by node and flags anything it is unsure about.
      </p>

      <h2 id="review">3. Review the model</h2>
      <p>
        Check the live diagram, resolve anything the model flagged, and pick your target cloud, AWS
        or Azure. This is <Link href="/docs/review-gate">the review gate</Link>: nothing is generated
        until you approve.
      </p>

      <h2 id="generate">4. Generate and ship</h2>
      <p>
        Approve the model and Terragram produces Terraform or OpenTofu plus a signed evidence bundle,
        ready to open as a pull request on GitHub or GitLab. Your data stays in the UK throughout
        (see <Link href="/docs/residency">data residency</Link>).
      </p>

      <Callout tone="note" title="Bring what you already have">
        You don&rsquo;t have to start from a blank page. Pick a template with{" "}
        <strong>Diagram to Terraform</strong> and edit it on the canvas, or paste existing Terraform
        with <strong>Terraform to Diagram</strong> to reverse-engineer a diagram from it.
      </Callout>
    </DocArticle>
  );
}
