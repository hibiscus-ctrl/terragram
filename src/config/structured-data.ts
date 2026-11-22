import { GITHUB_REPO_URL, hasPublicRepo } from "@/config/company";
import { SITE_URL } from "@/utils/site-url";

/**
 * Centralised JSON-LD builders so the marketing surface emits consistent
 * structured data. IDs are stable fragment URIs (`#organization`, `#website`,
 * `#software`) so schemas can reference each other across pages.
 */

const ORG_ID = `${SITE_URL}/#organization`;
const WEBSITE_ID = `${SITE_URL}/#website`;
const SOFTWARE_ID = `${SITE_URL}/#software`;

const organization = {
  "@type": "Organization",
  "@id": ORG_ID,
  name: "Terragram",
  legalName: "Terragram Ltd",
  url: SITE_URL,
  logo: `${SITE_URL}/opengraph-image`,
  email: "hello@terragram.dev",
  description:
    "Terragram translates between plain English, architecture diagrams and Terraform through one auditable model, with a review gate and signed evidence. Built for the UK public sector, open to everyone.",
  areaServed: ["GB", "EU"],
  ...(hasPublicRepo() ? { sameAs: [GITHUB_REPO_URL] } : {}),
};

const website = {
  "@type": "WebSite",
  "@id": WEBSITE_ID,
  name: "Terragram",
  url: SITE_URL,
  inLanguage: "en-GB",
  publisher: { "@id": ORG_ID },
};

const software = {
  "@type": "SoftwareApplication",
  "@id": SOFTWARE_ID,
  name: "Terragram",
  applicationCategory: "DeveloperApplication",
  applicationSubCategory: "Infrastructure-as-Code design & generation",
  operatingSystem: "Web",
  url: SITE_URL,
  description:
    "Terragram moves between plain English, architecture diagrams and Terraform through one auditable model. Four modes, bidirectional, targeting AWS or Azure, with a human review gate and signed evidence. UK data residency and managed UK inference.",
  publisher: { "@id": ORG_ID },
  offers: [
    {
      "@type": "Offer",
      name: "Free",
      price: "0",
      priceCurrency: "GBP",
      description: "Start diagramming, no card required.",
    },
    {
      "@type": "Offer",
      name: "Pro",
      priceCurrency: "GBP",
      description: "Unlimited diagrams, review gate, signed evidence and priority support.",
    },
  ],
};

/** The homepage graph: who we are, the site, and the product. */
export function siteGraph() {
  return {
    "@context": "https://schema.org",
    "@graph": [organization, website, software],
  };
}

/** A breadcrumb trail. `path` is a site-relative path; absolutised against SITE_URL. */
export function breadcrumbSchema(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: `${SITE_URL}${item.path}`,
    })),
  };
}

/** FAQ rich data. `answer` must be plain text (Google strips markup). */
export function faqSchema(items: { question: string; answer: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
}
