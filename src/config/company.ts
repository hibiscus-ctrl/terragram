// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

// Company + founder details for the marketing site (About page, footer, legal).
//
// Leave a field as "" until it is real. Every consumer guards on these values, so
// an empty field renders NOTHING — no placeholder, nothing false, is ever shown on
// the live site. Fill these in once the company is incorporated and the founder bio
// is signed off. See legal/COMPANIES-HOUSE-CHECKLIST.md for the registration steps.

export type CompanyDetails = {
  /** Registered legal name, e.g. "Terragram Ltd". */
  legalName: string;
  /** Companies House registration number, assigned at incorporation, e.g. "12345678". */
  companyNumber: string;
  /** Registered office address (one line), e.g. "1 Example St, London, EC1A 1AA". */
  registeredOffice: string;
  /** VAT registration number, if VAT-registered, e.g. "GB123456789". */
  vatNumber: string;
  /** Jurisdiction of incorporation. */
  jurisdiction: string;
};

export type Founder = {
  name: string;
  role: string;
  /** One or two sentences. */
  bio: string;
};

export const COMPANY: CompanyDetails = {
  legalName: "",
  companyNumber: "",
  registeredOffice: "",
  vatNumber: "",
  jurisdiction: "England & Wales",
};

export const FOUNDERS: Founder[] = [
  // { name: "Your Name", role: "Founder", bio: "One or two sentences about you and why Terragram." },
];

/**
 * The public source repository, e.g. "https://github.com/your-org/terragram".
 *
 * Same rule as the fields above: leave it "" until the repository actually exists
 * and is public. Every consumer guards on it, so an empty value renders NO GitHub
 * link anywhere — better than the header, the footer, the About page and two
 * SECURITY.md references all pointing at a 404.
 */
export const GITHUB_REPO_URL: string = "";

/** True once a public repository exists. */
export function hasPublicRepo(): boolean {
  return GITHUB_REPO_URL.trim().length > 0;
}

/** URL of a file at the repo root (e.g. "SECURITY.md"); "" when there is no repo. */
export function repoFileUrl(path: string): string {
  return hasPublicRepo() ? `${GITHUB_REPO_URL.replace(/\/$/, "")}/blob/main/${path}` : "";
}

/** True once the company is incorporated and its legal name is set. */
export function hasCompanyDetails(): boolean {
  return COMPANY.legalName.trim().length > 0;
}

/** True once at least one founder has a name. */
export function hasFounders(): boolean {
  return FOUNDERS.some((f) => f.name.trim().length > 0);
}

/** "Terragram Ltd (company no. 12345678)" — only the parts that are set. */
export function companyLine(): string {
  if (!hasCompanyDetails()) return "";
  const number = COMPANY.companyNumber.trim();
  return number ? `${COMPANY.legalName} (company no. ${number})` : COMPANY.legalName;
}
