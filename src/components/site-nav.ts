// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/** Primary marketing/global navigation — shared by the desktop {@link SiteHeader}
 *  and the mobile {@link MobileMenu} so the two never drift. An entry with
 *  `children` renders as a dropdown on desktop and an expanded group on mobile. */

export type NavChild = {
  label: string;
  href: string;
  /** Short blurb shown under the label in the desktop dropdown. */
  description?: string;
};

export type NavEntry = {
  label: string;
  href: string;
  children?: readonly NavChild[];
};

/** Curated highlights for the Docs dropdown — a short, high-signal subset of the
 *  full docs index (see `config/navigation.ts`). */
const DOCS_MENU: readonly NavChild[] = [
  { label: "Overview", href: "/docs", description: "What Terragram is and how it works." },
  {
    label: "Quickstart",
    href: "/docs/quickstart",
    description: "From a sentence to Terraform in a few minutes.",
  },
  {
    label: "The four modes",
    href: "/docs/modes",
    description: "Chat, diagram and Terraform, in any direction.",
  },
  {
    label: "The review gate",
    href: "/docs/review-gate",
    description: "Approve the model and get signed evidence before code lands.",
  },
  {
    label: "Data residency",
    href: "/docs/residency",
    description: "UK South / UK West storage and managed UK inference.",
  },
];

export const MARKETING_NAV: readonly NavEntry[] = [
  { label: "Home", href: "/" },
  { label: "Features", href: "/features" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs", children: DOCS_MENU },
  { label: "About", href: "/about" },
];
