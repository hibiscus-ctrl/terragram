import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { MembersClient } from "@/components/app/members-client";
import { guardPage } from "@/features/account/controllers/page-guards";
import { getMembersView } from "@/features/app/reads/members";

export const metadata: Metadata = { title: "Members" };
export const dynamic = "force-dynamic";

export default async function MembersPage() {
  await guardPage("members.manage");
  const view = await getMembersView();
  // The guard has already let only `members.manage` through; a null view is a
  // membership that vanished in between.
  if (!view) redirect("/login");
  return <MembersClient view={view} />;
}
