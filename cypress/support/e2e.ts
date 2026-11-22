// Loaded before every spec (see `supportFile` in cypress.config.ts).
// Registers Testing Library queries (cy.findByRole / cy.findByLabelText) and the
// project's custom commands.
import "@testing-library/cypress/add-commands";
import { recordConsentChoice } from "./commands";

// Signed-out specs; cy.login() records it again after cy.session clears cookies.
beforeEach(() => {
  recordConsentChoice();
});

/**
 * React 19's dev-only Server Component performance instrumentation intermittently
 * calls `performance.measure()` with a negative timestamp under `next dev`:
 *   Failed to execute 'measure' on 'Performance': '…' cannot have a negative time stamp.
 * Cypress fails the running test on ANY uncaught application error, so this lands
 * on whichever spec happens to be mid-flight. It is instrumentation, not
 * application logic, and it is stripped from a production build (`npm run e2e:ci`).
 *
 * Deliberately NARROW: only this signature is swallowed. A blanket `return false`
 * would hide real application errors and quietly gut the suite.
 */
Cypress.on("uncaught:exception", (err) => {
  const isReactDevPerfNoise =
    /Failed to execute 'measure' on 'Performance'/.test(err.message) &&
    /cannot have a negative time stamp/.test(err.message);
  return isReactDevPerfNoise ? false : undefined;
});
