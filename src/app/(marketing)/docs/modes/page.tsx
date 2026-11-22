// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";

import { Callout } from "@/components/content/callout";
import { DocArticle } from "@/components/docs/doc-article";

export const metadata: Metadata = {
  title: "The four modes",
  description: "Chat, diagram and Terraform, in any direction, all through one auditable model.",
  alternates: { canonical: "/docs/modes" },
};

export default function ModesDoc() {
  return (
    <DocArticle
      current="/docs/modes"
      title="The four modes"
      description="Terragram translates between plain English, architecture diagrams and Terraform. Everything flows through one internal model, so the three never drift apart. Pick a direction and go; you can switch modes any time from the workspace toolbar."
    >
      <h2 id="one-model">One model, four directions</h2>
      <p>
        A workspace holds a single internal model of your architecture. Each mode is just a
        direction of travel into or out of that model, which is why you can start from a sentence,
        end in Terraform, and still get a diagram that matches, all without repeating yourself.
      </p>

      <h2 id="chat-to-diagram">Chat to Diagram</h2>
      <p>
        Describe your architecture the way you would to a colleague, and Terragram drafts the diagram
        node by node, flagging anything it is unsure about so you can correct it early.
      </p>

      <h2 id="chat-to-terraform">Chat to Terraform</h2>
      <p>
        Describe it in plain English and get review-ready Terraform or OpenTofu, targeting AWS or
        Azure. The diagram is kept in sync so you can see what the code represents before you ship
        it.
      </p>

      <h2 id="diagram-to-terraform">Diagram to Terraform</h2>
      <p>
        Start from a picture of your diagram — a screenshot of a slide, a photo of a whiteboard —
        or paste a Mermaid flowchart, or begin from a template. Then shape it on the canvas: add
        components from the palette, connect them, and delete what you do not need. Terragram
        generates compliant infrastructure code from the diagram, and every connection you draw
        appears in the code as a real provider reference.
      </p>
      <p>
        A picture is read by managed UK inference, so it needs managed models enabled for your
        organisation; a Mermaid flowchart is read without any inference at all. Either way each
        box becomes a component by its label and each arrow becomes a connection you own. A box
        that matches nothing stays on the diagram and is flagged rather than dropped. draw.io
        files are not read as files — screenshot them.
      </p>

      <h2 id="terraform-to-diagram">Terraform to Diagram</h2>
      <p>
        Paste or open existing Terraform and Terragram reconstructs the architecture diagram, so you
        can keep living documentation that never falls behind the code it describes. It reads the
        resources, the settings on them, and the references between them — the diagram shows the
        topology your file actually declares, not a guess at it.
      </p>
      <p>
        A module or data source Terragram cannot translate stays on the diagram, flagged as
        untranslated. It is never silently dropped, because a diagram that quietly omits part of
        your infrastructure is worse than one that admits what it could not read.
      </p>

      <Callout tone="safe" title="Nothing lands without review">
        Whichever direction you work in, generated code only leaves the workspace once you approve
        the model at <Link href="/docs/review-gate">the review gate</Link> and Terragram has produced
        a signed evidence bundle.
      </Callout>

      <h2 id="switching">Switching modes</h2>
      <p>
        Because all four modes share one model, switching is free: move from Chat to Diagram to
        refine the shape, then to Terraform to generate, then back to Diagram to document. You never
        lose context, and the three representations stay consistent.
      </p>
    </DocArticle>
  );
}
