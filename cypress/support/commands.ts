// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

// Shared Cypress custom commands.

declare global {
  namespace Cypress {
    interface Chainable {
      /**
       * Sign in through the real login form, cached with cy.session so each user
       * authenticates at most once per run (`cacheAcrossSpecs`). The session setup
       * also seeds the user (idempotently), so every spec runs on its own.
       *
       * UI login is deliberate: @supabase/ssr stores the session in chunked,
       * base64-encoded cookies whose format is an implementation detail — hand-
       * rolling them for a programmatic login would be fragile.
       *
       * `signInWithPassword` is rate-limited per IP; session caching keeps the
       * suite under it. Defaults to the e2e user (cypress.config.ts `expose`).
       */
      login(email?: string, password?: string): Chainable<void>;
      /**
       * Wait until react-dom has attached to `selector` (default `"form"`).
       * Required before touching the auth forms: they submit natively — and
       * therefore silently — if clicked before hydration.
       */
      hydrated(selector?: string): Chainable<void>;
      /**
       * Retry `click` until `selector` appears — the SSR'd trigger exists before
       * React attaches its handler, so the first click on a menu or dialog
       * trigger can be swallowed. A targeted retry of a known race, not a sleep.
       */
      clickUntil(selector: string, click: () => void, attempts?: number): Chainable<void>;
      /** cy.task("seedWorkspace") — the deterministic fixture workspace. */
      task(
        event: "seedWorkspace",
        arg?: undefined,
        options?: Partial<Cypress.Loggable & Cypress.Timeoutable>,
      ): Chainable<{ id: string; name: string; snapshots: number }>;
      /** cy.task("cleanupWorkspaces") — deletes the e2e user's `e2e-*` workspaces. */
      task(
        event: "cleanupWorkspaces",
        arg?: undefined,
        options?: Partial<Cypress.Loggable & Cypress.Timeoutable>,
      ): Chainable<{ cleaned: number }>;
      /** cy.task("cleanupTeam") — removes the members spec's invitees and invites. */
      task(
        event: "cleanupTeam",
        arg?: undefined,
        options?: Partial<Cypress.Loggable & Cypress.Timeoutable>,
      ): Chainable<{ removedMembers: number; removedInvites: number }>;
    }
  }
}

/**
 * Kept in step with CONSENT_COOKIE in src/config/analytics.ts (not imported:
 * that module reads `process.env`, which the browser bundle does not define);
 * tests/cypress-consent.test.ts fails if the two drift.
 */
const CONSENT_COOKIE = "tg-analytics-consent";

/**
 * Record an analytics-consent choice so the banner never renders. It shows only
 * when a GA id is configured (so locally, not in CI), appears after hydration,
 * and is `fixed bottom-0`: it lands over whatever sits low on the page, and a
 * click aimed there hits the banner instead. No spec covers the banner itself;
 * one that does must clear this cookie first.
 */
export function recordConsentChoice() {
  cy.setCookie(CONSENT_COOKIE, "denied");
}

Cypress.Commands.add("login", (email?: string, password?: string) => {
  const user = email ?? (Cypress.expose("E2E_USER_EMAIL") as string);
  const pass = password ?? (Cypress.expose("E2E_USER_PASSWORD") as string);

  cy.session(
    ["password-user", user],
    () => {
      // Seed inside the session setup: it only runs on a cache miss.
      cy.task("seedUser", { email: user, password: pass });
      cy.visit("/login");
      // The form is `<form onSubmit={…}>` with no `action`, so a click before
      // React attaches performs a NATIVE submit that silently re-GETs /login,
      // and typing early is dropped by the hydration re-render.
      cy.hydrated("form");
      cy.findByLabelText("Email").type(user);
      cy.findByLabelText("Password").type(pass, { log: false });
      cy.findByRole("button", { name: "Sign in" }).click();
      // First login also provisions the user's org before landing.
      cy.location("pathname", { timeout: 20000 }).should("eq", "/workspace");
    },
    { cacheAcrossSpecs: true },
  );
  // cy.session clears every cookie before restoring the cached ones.
  recordConsentChoice();
});

/**
 * react-dom stamps `__reactFiber$…` / `__reactProps$…` onto every DOM node it
 * owns at hydration — the probe is that marker rather than any one control's
 * behaviour, so a spec can still test the control itself.
 */
Cypress.Commands.add("hydrated", (selector = "form") => {
  cy.get(selector, { timeout: 30000 }).should(($el) => {
    const attached = $el
      .toArray()
      .some((node) =>
        Object.keys(node).some((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$")),
      );
    expect(attached, `React has hydrated "${selector}"`).to.equal(true);
  });
});

Cypress.Commands.add("clickUntil", (selector: string, click: () => void, attempts = 4) => {
  const tryOpen = (remaining: number) => {
    cy.get("body").then(($body) => {
      if ($body.find(selector).length > 0) return;
      if (remaining <= 0) {
        throw new Error(`"${selector}" never appeared — the trigger may be broken, not merely un-hydrated.`);
      }
      click();
      tryOpen(remaining - 1);
    });
  };
  tryOpen(attempts);
  cy.get(selector).should("be.visible");
});

