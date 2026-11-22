// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { PropsWithChildren } from "react";
import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";

import { CookieConsent } from "@/components/analytics/cookie-consent";
import { SkipLink } from "@/components/skip-link";
import { Toaster } from "@/components/ui/sonner";
import { GA_MEASUREMENT_ID } from "@/config/analytics";
import { cn } from "@/utils/cn";
import { SITE_URL } from "@/utils/site-url";

import "@/styles/globals.css";

const sourceSans = Source_Sans_3({
  variable: "--font-source",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const description =
  "Terragram translates between plain English, architecture diagrams and Terraform through one auditable model, with a review gate and signed evidence. UK data residency, managed UK inference. Built for the UK public sector, open to everyone.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Terragram — from plain English to Terraform",
    template: "%s · Terragram",
  },
  description,
  applicationName: "Terragram",
  openGraph: {
    title: "Terragram — from plain English to Terraform",
    description,
    url: SITE_URL,
    siteName: "Terragram",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Terragram — from plain English to Terraform",
    description,
  },
};

// themeColor / viewport belong in the dedicated `viewport` export as of Next 14
// (putting them in `metadata` is deprecated). Terragram ships a single warm light
// theme, so we declare `colorScheme: 'light'` (native controls/scrollbars render
// light even on a dark-OS device) and a single matching chrome tint, rather than
// advertising a dark scheme the app doesn't implement.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light",
  themeColor: "#FAF8F4",
};

export default function RootLayout({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      {/* suppressHydrationWarning: browser extensions (Grammarly, password managers)
          inject attributes like data-gr-ext-installed onto <body> before React
          hydrates, which otherwise logs a benign hydration-mismatch warning. This
          only suppresses the <body> element's own attribute diff, nothing deeper. */}
      <body
        suppressHydrationWarning
        className={cn("min-h-dvh font-sans antialiased", sourceSans.variable, jetbrains.variable)}
      >
        <SkipLink />
        {children}
        <Toaster />
        {GA_MEASUREMENT_ID && <CookieConsent gaId={GA_MEASUREMENT_ID} />}
      </body>
    </html>
  );
}
