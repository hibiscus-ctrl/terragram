import { redirect } from "next/navigation";

import { getOrCreateOrg } from "@/features/account/controllers/get-or-create-org";

export default async function AccountPage() {
  // Provision the personal org (idempotent) then land on the billing dashboard.
  await getOrCreateOrg();
  redirect("/billing");
}
