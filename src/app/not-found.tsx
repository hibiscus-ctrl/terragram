// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { Compass } from "lucide-react";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { StatusPage } from "@/components/status-page";

export const metadata: Metadata = {
  title: "Page not found",
  description: "The page you were looking for doesn’t exist or has moved.",
};

/**
 * Global 404. Lives at the app root, so it renders under the root layout only —
 * we add the marketing header/footer here to keep the chrome consistent.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <SiteHeader />
      <main className="flex-1">
        <StatusPage
          code="404 · Not found"
          icon={Compass}
          title="We can’t find that page"
          message={
            <>
              That link may be broken, or the page may have moved. Let&rsquo;s get you back on solid
              ground.
            </>
          }
          primary={{ label: "Back to home", href: "/" }}
          secondary={{ label: "Browse the docs", href: "/docs" }}
          links={[
            { label: "Help centre", href: "/help" },
            { label: "FAQ", href: "/faq" },
            { label: "Pricing", href: "/pricing" },
            { label: "Contact", href: "/contact" },
          ]}
        />
      </main>
      <SiteFooter />
    </div>
  );
}
