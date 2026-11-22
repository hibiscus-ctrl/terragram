import type { PropsWithChildren } from "react";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/app/app-shell";
import { getAppIdentity } from "@/features/account/controllers/app-identity";

// The account dashboard (Billing, Members, Settings) for the user's ACTIVE org,
// resolved ambiently from the active-org cookie and their memberships — there is no
// org slug in the URL; the sidebar's org menu switches it. Auth is enforced at the edge (PROTECTED_PREFIXES) and re-checked
// here as defense-in-depth. The workspace has its own full-viewport layout and is
// deliberately outside this shell.
export default async function DashboardLayout({ children }: PropsWithChildren) {
  const { orgChip, orgs, activeOrgId, role } = await getAppIdentity();
  if (!orgChip) redirect("/login");

  return (
    <AppShell
      org={orgChip}
      orgs={orgs}
      activeOrgId={activeOrgId}
      orgRole={role}
    >
      {children}
    </AppShell>
  );
}
