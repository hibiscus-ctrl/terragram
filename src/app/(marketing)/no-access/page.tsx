// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";

import { StatusPage } from "@/components/status-page";

export const metadata: Metadata = {
  title: "No access",
  description: "You don’t have permission to view this page.",
};

/**
 * 403 / no-access screen. Lives in the marketing group, so it inherits the
 * shared header + footer. Linked to from access-denied redirects (e.g. an
 * org-scoped route a member isn't entitled to).
 */
export default function NoAccessPage() {
  return (
    <StatusPage
      code="403 · No access"
      icon={ShieldAlert}
      title="You don’t have access to this"
      message={
        <>
          This page is restricted. You may need to sign in with a different account, or ask an admin
          of your organisation to grant you access.
        </>
      }
      primary={{ label: "Go to dashboard", href: "/login" }}
      secondary={{ label: "Sign in", href: "/login" }}
      links={[
        { label: "Back to home", href: "/" },
        { label: "Contact support", href: "/contact" },
        { label: "Help centre", href: "/help" },
      ]}
    />
  );
}
