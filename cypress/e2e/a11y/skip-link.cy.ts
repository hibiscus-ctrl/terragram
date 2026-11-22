// The skip link is visually hidden until focused (`sr-only` → `focus:not-sr-only`).
// The invariant is that a keyboard user can reach it FIRST and that it points at
// a target that actually exists — a skip link aimed at a missing #main-content is
// worse than none, and renders as a passing "link exists" check.

describe("Skip link", () => {
  for (const path of ["/", "/login", "/pricing"]) {
    it(`${path} → skip link is the first focusable control and targets main`, () => {
      cy.visit(path);
      cy.get('a[href="#main-content"]').as("skipLink");

      // Cypress counts an `sr-only` element as "visible" (a clipped 1x1 box), so
      // measure the rendered box instead.
      cy.get("@skipLink").then(($el) => {
        expect($el.outerWidth(), "skip link should be clipped until focused").to.be.lessThan(5);
      });
      cy.get("@skipLink")
        .focus()
        .should("have.focus")
        .then(($el) => {
          expect($el.outerWidth(), "focused skip link should be presented").to.be.greaterThan(40);
        });

      cy.get('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')
        .first()
        .should("have.attr", "href", "#main-content");
      cy.get("#main-content").should("exist");
    });
  }
});
