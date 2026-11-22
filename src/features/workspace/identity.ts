// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";

import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";

export type WorkspaceUser = { name: string; initials: string };

/** Resolve the signed-in user for the workspace chrome, or redirect to /login. */
export async function requireWorkspaceUser(): Promise<WorkspaceUser> {
  const user = await getAuthenticatedUser();
  if (!user) redirect("/login");

  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name =
    (typeof meta.full_name === "string" && meta.full_name) || user.email || "Signed-in user";
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p.charAt(0))
      .join("")
      .toUpperCase() || "?";

  return { name, initials };
}
