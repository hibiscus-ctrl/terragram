/**
 * Plumbing for the DELIBERATELY UNCONFIGURED server suite.
 *
 * Sibling of `tests/api/helpers/client.ts`, pointed at a second server (port
 * 3101, booted from `.env.test.unconfigured`) whose only difference is that the
 * secrets are blank. Several cases have "a required key is absent" as their
 * PREMISE, and a route reads `process.env` inside its own process, so no
 * test-side mutation can reach it.
 *
 * SEPARATE GATE VARIABLE, on purpose: this reads `API_TEST_UNCONFIGURED_BASE_URL`,
 * never `API_TEST_BASE_URL`, so the two suites can never be pointed at each
 * other's server, and this one self-skips under plain `npm test`.
 */
import supertest from "supertest";

export const BASE_URL = process.env.API_TEST_UNCONFIGURED_BASE_URL ?? "";

/** Gate for this suite — false under plain `npm test`. */
export const CONFIGURED = Boolean(BASE_URL);

// The runner is launched with only .env.test.unconfigured; the site origin every
// redirect must stay on comes from .env.local, which Next loads for the SERVER
// but which never reaches this process. loadEnvFile keeps already-set vars.
if (CONFIGURED && !process.env.NEXT_PUBLIC_SITE_URL) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local: the server falls back to localhost:3000, and so does this.
  }
}

export const SITE_ORIGIN = new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").origin;

export function api(): ReturnType<typeof supertest> {
  return supertest(BASE_URL);
}
