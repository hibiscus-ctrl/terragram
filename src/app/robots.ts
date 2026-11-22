import type { MetadataRoute } from "next";

import { SITE_URL } from "@/utils/site-url";

/**
 * Generates `/robots.txt`. The marketing surface is crawlable; everything behind
 * auth (the workspace, billing, settings, account) and the API are kept out of the
 * index — they're either private, per-user, or non-content. `/shared` is public by
 * design but must never be indexed: the token in the URL is the capability, so a
 * crawled review link would be a leaked one. `/invite` is public for the same reason
 * and must never be indexed either. Points crawlers at the sitemap.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/workspace",
        "/billing",
        "/settings",
        "/members",
        "/account",
        "/no-access",
        "/shared/",
        "/invite/",
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
