// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";

import { Callout } from "@/components/content/callout";
import { DocArticle } from "@/components/docs/doc-article";

export const metadata: Metadata = {
  title: "Data residency",
  description: "UK South / UK West storage and managed UK inference, kept in region.",
  alternates: { canonical: "/docs/residency" },
};

export default function ResidencyDoc() {
  return (
    <DocArticle
      current="/docs/residency"
      title="Data residency"
      description="Terragram is built for the UK public sector, so residency is a first-class promise, not a setting you have to find. Data stays in the UK, and inference runs on managed, in-region endpoints."
    >
      <h2 id="storage">Where your data lives</h2>
      <p>
        Your workspaces, models, diagrams and evidence bundles are stored in the UK, across{" "}
        <strong>UK South and UK West</strong> for resilience. Data at rest does not leave the UK.
      </p>

      <h2 id="inference">Inference</h2>
      <p>
        The models that power translation run on <strong>managed, in-region endpoints</strong>, so
        your architecture descriptions and diagrams are processed in the UK. Enterprise plans can add
        BYOK and private endpoints for stricter isolation.
      </p>

      <h2 id="training">Your work is yours</h2>
      <p>
        Architecture descriptions, diagrams and generated code belong to you. We do not use your
        designs to train models, and they are never shared with third parties.
      </p>

      <Callout tone="safe" title="At a glance">
        <ul className="mt-1 mb-0">
          <li>Data at rest: UK (UK South / UK West).</li>
          <li>Inference: managed, in-region UK endpoints.</li>
          <li>Never used for training; never shared with third parties.</li>
          <li>Enterprise: BYOK, private endpoints, audit-log export and a DPA.</li>
        </ul>
      </Callout>

      <p>
        For the wider security posture and procurement routes, see the{" "}
        <Link href="/trust-center">Trust Center</Link>.
      </p>
    </DocArticle>
  );
}
