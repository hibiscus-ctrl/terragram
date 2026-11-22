// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { MetadataRoute } from "next";

import { SITE_URL } from "@/utils/site-url";

/**
 * Generates `/sitemap.xml` for the public marketing + docs surface. Kept as an
 * explicit list (not a filesystem crawl) so auth-gated, per-user, and legal-only
 * routes never leak into the index — it mirrors the `disallow` set in robots.ts.
 * Update this when a public page is added.
 */
type Entry = {
  path: string;
  priority: number;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
};

const ROUTES: Entry[] = [
  { path: "", priority: 1, changeFrequency: "weekly" },
  { path: "/features", priority: 0.9, changeFrequency: "weekly" },
  { path: "/pricing", priority: 0.9, changeFrequency: "weekly" },
  { path: "/docs", priority: 0.8, changeFrequency: "weekly" },
  { path: "/docs/quickstart", priority: 0.7, changeFrequency: "monthly" },
  { path: "/docs/modes", priority: 0.7, changeFrequency: "monthly" },
  { path: "/docs/review-gate", priority: 0.6, changeFrequency: "monthly" },
  { path: "/docs/residency", priority: 0.6, changeFrequency: "monthly" },
  { path: "/about", priority: 0.7, changeFrequency: "monthly" },
  { path: "/trust-center", priority: 0.7, changeFrequency: "monthly" },
  { path: "/verify", priority: 0.6, changeFrequency: "monthly" },
  { path: "/faq", priority: 0.6, changeFrequency: "monthly" },
  { path: "/help", priority: 0.5, changeFrequency: "monthly" },
  { path: "/contact", priority: 0.5, changeFrequency: "yearly" },
  { path: "/privacy", priority: 0.3, changeFrequency: "yearly" },
  { path: "/terms", priority: 0.3, changeFrequency: "yearly" },
  { path: "/cookies", priority: 0.3, changeFrequency: "yearly" },
  { path: "/confidentiality", priority: 0.3, changeFrequency: "yearly" },
  { path: "/accessibility", priority: 0.3, changeFrequency: "yearly" },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return ROUTES.map(({ path, priority, changeFrequency }) => ({
    url: `${SITE_URL}${path}`,
    lastModified,
    changeFrequency,
    priority,
  }));
}
