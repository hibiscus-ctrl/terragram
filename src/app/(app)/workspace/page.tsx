// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { ModePicker } from "@/components/workspace/mode-picker";
import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import { requireWorkspaceUser } from "@/features/workspace/identity";
import { listWorkspaces } from "@/features/workspace/store";

export default async function WorkspaceHomePage() {
  const user = await requireWorkspaceUser();
  // requireWorkspaceUser already resolved (and cached) the auth user; reuse it for the id.
  const authUser = await getAuthenticatedUser();
  const workspaces = authUser ? await listWorkspaces(authUser.id) : [];
  return <ModePicker user={user} workspaces={workspaces} />;
}
