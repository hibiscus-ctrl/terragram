// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { LeaveOrgPanel } from "@/components/app/leave-org-panel";
import { WorkspaceSettings } from "@/components/workspace/workspace-settings";
import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import { getLeaveView } from "@/features/app/reads/members";
import { gitProviderStatusAction } from "@/features/git/actions";
import { requireWorkspaceUser } from "@/features/workspace/identity";
import { DEFAULT_SETTINGS } from "terragram-engine/settings";
import { getSettings } from "@/features/workspace/store";
import { managedEngineEnabled } from "@/features/workspace/translate";

export default async function WorkspaceSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; git_error?: string }>;
}) {
  await requireWorkspaceUser();
  const authUser = await getAuthenticatedUser();
  const [settings, git, params, leaveView] = await Promise.all([
    authUser ? getSettings(authUser.id) : Promise.resolve(DEFAULT_SETTINGS),
    gitProviderStatusAction(),
    searchParams,
    getLeaveView(),
  ]);
  const gitNotice = params.connected
    ? { kind: "connected" as const, detail: params.connected }
    : params.git_error
      ? { kind: "error" as const, detail: params.git_error }
      : null;
  return (
    <WorkspaceSettings
      initial={settings}
      git={git}
      gitNotice={gitNotice}
      managedInference={managedEngineEnabled()}
      organisation={leaveView ? <LeaveOrgPanel view={leaveView} /> : null}
    />
  );
}
