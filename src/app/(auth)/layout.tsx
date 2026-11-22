import type { PropsWithChildren } from "react";
import type { Metadata } from "next";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: true },
};

export default function AuthLayout({ children }: PropsWithChildren) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <SiteHeader />
      {/* `id`/`tabIndex` are what make the header's skip link land somewhere: without
          them "Skip to main content" is a dead anchor on /login and /signup. */}
      <main
        id="main-content"
        tabIndex={-1}
        className="flex flex-1 items-center justify-center px-4 py-12 outline-none"
      >
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
