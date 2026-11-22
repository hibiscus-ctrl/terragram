// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SharedWorkspace } from "@/components/workspace/shared-workspace";
import { CLOUD_LABEL, MODE_META } from "@/features/workspace/modes";
import { resolveShareLink } from "@/features/workspace/store";
import { emitTerraform } from "@/features/workspace/terraform";
import { explainModel } from "@/features/workspace/explain";

/** A review link is not a publication. Keep it out of search results. */
export const metadata: Metadata = {
  title: "Shared for review",
  robots: { index: false, follow: false },
};

export default async function SharedWorkspacePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const shared = await resolveShareLink(token);

  // Unknown, revoked and expired all look identical from here, so a link cannot be
  // probed to learn whether a workspace exists.
  if (!shared) notFound();

  const terraform = emitTerraform(shared.model, shared.summary.cloud, shared.summary.tool);
  const explanation = explainModel(shared.model, shared.summary.cloud, terraform.regionLabel);

  return (
    <SharedWorkspace
      name={shared.summary.name}
      subtitle={`${MODE_META[shared.summary.mode].title} · ${CLOUD_LABEL[shared.summary.cloud]} · ${terraform.regionLabel}`}
      model={shared.model}
      files={terraform.files}
      explanation={explanation}
      receipts={shared.receipts.map((r) => ({
        id: r.id,
        contentHash: r.contentHash,
        signed: r.signed,
        approver: r.approver,
        approvedAt: r.approvedAt,
      }))}
    />
  );
}
