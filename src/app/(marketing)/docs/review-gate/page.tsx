import type { Metadata } from "next";
import Link from "next/link";

import { Callout } from "@/components/content/callout";
import { DocArticle } from "@/components/docs/doc-article";

export const metadata: Metadata = {
  title: "The review gate",
  description: "Approve the model and get a signed SBOM and plan before any code lands.",
  alternates: { canonical: "/docs/review-gate" },
};

export default function ReviewGateDoc() {
  return (
    <DocArticle
      current="/docs/review-gate"
      title="The review gate"
      description="Terragram never lands code behind your back. Before anything is generated, a human approves the model, and every generation ships with signed evidence you can verify later."
    >
      <h2 id="why">Why a gate</h2>
      <p>
        A model can be confident and wrong. The review gate makes the human the final authority:
        Terragram proposes, you dispose. It is the difference between a slick demo and infrastructure
        a reviewer can defend in an audit.
      </p>

      <h2 id="what-you-see">What you review</h2>
      <p>At the gate you see the whole model before any code exists:</p>
      <ul>
        <li>The live architecture diagram, with every node and edge.</li>
        <li>
          A plain-English description of the design, so approving does not require reading
          Terraform.
        </li>
        <li>Anything the model flagged as uncertain, called out for you to confirm or correct.</li>
        <li>Your target cloud (AWS or Azure) and the shape of what will be generated.</li>
      </ul>

      <h2 id="evidence">Signed evidence</h2>
      <p>
        When you approve, Terragram generates the code and attaches a <strong>signed evidence
        bundle</strong>: the model, the plan, the description you were shown, and a receipt carrying
        a SHA-256 content hash over all of it, signed with Ed25519. The decision is provable, not
        just logged.
      </p>
      <p>
        The bundle carries the public key it is checked against, so verifying it needs nothing from
        us. Drop it on <Link href="/verify">the verifier</Link>: the page recomputes the hash from
        the model and plan in the bundle and checks the signature, entirely in your browser. Change
        one byte of the plan and it fails. That check keeps working if Terragram is unreachable, or
        gone.
      </p>

      <Callout tone="safe" title="The guarantees">
        <ul className="mt-1 mb-0">
          <li>No code is generated until a human approves the model.</li>
          <li>Every generation carries a signed, independently verifiable bundle.</li>
          <li>Approvals are recorded, so the audit trail outlives the browser tab.</li>
          <li>Terragram never applies infrastructure; you merge the pull request.</li>
        </ul>
      </Callout>

      <h2 id="next">Where the code goes</h2>
      <p>
        Approved output opens as a pull request on GitHub or GitLab, so your normal review and CI run
        on top. See the <Link href="/docs/quickstart">quickstart</Link> for the full flow.
      </p>
    </DocArticle>
  );
}
