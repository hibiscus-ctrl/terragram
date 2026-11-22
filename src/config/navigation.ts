// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { GITHUB_REPO_URL, hasPublicRepo } from "@/config/company";

/**
 * Single source of truth for the site's secondary navigation.
 *
 * Drives three surfaces so they can never drift apart:
 *  - the docs sidebar (`docsNav`)
 *  - the right-hand "aside" nav on every legal/support page (`legalNav`)
 *  - the footer columns (`footerColumns`)
 */

export type NavItem = {
  label: string;
  href: string;
  /** Short blurb — surfaced in card grids and the legal aside. */
  description?: string;
};

export type NavSection = {
  title: string;
  items: NavItem[];
};

/* ------------------------------------------------------------------ docs -- */

export const docsNav: NavSection[] = [
  {
    title: "Get started",
    items: [
      {
        label: "Overview",
        href: "/docs",
        description: "What Terragram is, how the one-model translation works, and where to go next.",
      },
      {
        label: "Quickstart",
        href: "/docs/quickstart",
        description: "Open a workspace, describe what you need, and get Terraform in minutes.",
      },
      {
        label: "The four modes",
        href: "/docs/modes",
        description:
          "Chat, diagram and Terraform, in any direction, all through one auditable model.",
      },
    ],
  },
  {
    title: "Working with Terragram",
    items: [
      {
        label: "The review gate",
        href: "/docs/review-gate",
        description: "Approve the model and get a signed SBOM + plan before any code lands.",
      },
      {
        label: "Data residency",
        href: "/docs/residency",
        description: "UK South / UK West storage and managed UK inference, kept in region.",
      },
    ],
  },
];

/** Flat list of every doc page, in reading order — used for prev/next. */
export const docsFlat: NavItem[] = docsNav.flatMap((section) => section.items);

/* ----------------------------------------------------------------- legal -- */

/**
 * The legal / support pages. This exact list renders in the right-hand aside of
 * every one of these pages, so a visitor can hop between connecting pages.
 */
export const legalNav: NavItem[] = [
  {
    label: "About",
    href: "/about",
    description: "Who builds Terragram, and the principles behind it.",
  },
  {
    label: "Trust Center",
    href: "/trust-center",
    description: "Our security posture, certifications and data residency.",
  },
  {
    label: "Verify a bundle",
    href: "/verify",
    description: "Check an evidence bundle in your own browser, offline.",
  },
  { label: "Help centre", href: "/help", description: "Set-up walkthroughs and troubleshooting." },
  { label: "FAQ", href: "/faq", description: "Quick answers to the questions we hear most." },
  { label: "Contact", href: "/contact", description: "Reach support, security or the founders." },
  {
    label: "Privacy Policy",
    href: "/privacy",
    description: "What we collect, why, and your rights.",
  },
  {
    label: "Cookie Policy",
    href: "/cookies",
    description: "The cookies we set and how to control them.",
  },
  {
    label: "Confidentiality",
    href: "/confidentiality",
    description: "How we handle your code and confidential data.",
  },
  {
    label: "Accessibility",
    href: "/accessibility",
    description: "Our WCAG 2.2 AA conformance, and the gaps we know about.",
  },
  {
    label: "Terms & Conditions",
    href: "/terms",
    description: "The agreement that governs using Terragram.",
  },
];

/* ---------------------------------------------------------------- footer -- */

export const footerColumns: NavSection[] = [
  {
    title: "Platform",
    items: [
      { label: "Home", href: "/" },
      { label: "Features", href: "/features" },
      { label: "About", href: "/about" },
      { label: "Pricing", href: "/pricing" },
      { label: "Documentation", href: "/docs" },
    ],
  },
  {
    title: "Resources",
    items: [
      { label: "Help centre", href: "/help" },
      { label: "FAQ", href: "/faq" },
      { label: "Quickstart", href: "/docs/quickstart" },
      { label: "The review gate", href: "/docs/review-gate" },
      { label: "Trust Center", href: "/trust-center" },
      { label: "Verify a bundle", href: "/verify" },
      // Dropped entirely while there is no public repository — see config/company.ts.
      ...(hasPublicRepo() ? [{ label: "GitHub", href: GITHUB_REPO_URL }] : []),
    ],
  },
  {
    title: "Company",
    items: [
      { label: "About", href: "/about" },
      { label: "Contact", href: "/contact" },
      { label: "Confidentiality", href: "/confidentiality" },
    ],
  },
  {
    title: "Legal",
    items: [
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Cookie Policy", href: "/cookies" },
      { label: "Accessibility", href: "/accessibility" },
      { label: "Terms & Conditions", href: "/terms" },
    ],
  },
];
