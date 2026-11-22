// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";

import { SettingsClient } from "@/components/app/settings-client";
import { getCurrentMembership } from "@/features/account/controllers/get-or-create-org";
import { guardPage } from "@/features/account/controllers/page-guards";
import { can } from "@/features/account/controllers/permissions";
import { getTransferCandidates } from "@/features/app/reads/members";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await guardPage("org.settings");
  const membership = await getCurrentMembership();
  const canManage = membership ? can(membership.role, "org.settings") : false;
  // Only a caller who may hand the org over needs the candidates.
  const transferCandidates =
    membership && can(membership.role, "org.transfer") ? await getTransferCandidates() : [];

  return (
    <SettingsClient
      orgName={membership?.org.github_login ?? "—"}
      canManage={canManage}
      transferCandidates={transferCandidates}
    />
  );
}
