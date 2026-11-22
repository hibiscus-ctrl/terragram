// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { PropsWithChildren } from "react";
import type { Metadata } from "next";

import { requireWorkspaceUser } from "@/features/workspace/identity";

export const metadata: Metadata = {
  title: "Workspace",
  robots: { index: false, follow: false },
};

// The workspace is a full-viewport application surface with its own top bar — it
// deliberately skips the marketing header/footer. Auth is enforced at the edge
// (PROTECTED_PREFIXES) and re-checked here as defense-in-depth.
export default async function WorkspaceLayout({ children }: PropsWithChildren) {
  await requireWorkspaceUser();
  return <div className="min-h-dvh bg-background">{children}</div>;
}
