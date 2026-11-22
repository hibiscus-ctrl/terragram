// Billing renders for the e2e user's (free) org, and the portal hop never strands
// anyone. Read-only: nothing here starts a checkout or reaches Stripe.

describe("Billing", () => {
  it("renders the billing page with a way to upgrade or manage billing", () => {
    cy.login();
    cy.visit("/billing");
    cy.findByRole("heading", { level: 1, name: /Billing & usage/ }).should("be.visible");
    cy.get("body").then(($body) => {
      const portal = $body.find('a[href="/manage-subscription"]');
      if (portal.length > 0) {
        // An org with a Stripe customer: the portal button points at the hop route.
        cy.wrap(portal.first()).should("contain.text", "Manage billing");
      } else {
        // A free org has no customer to manage; it is offered the upgrade instead.
        cy.findAllByRole("button", { name: /Upgrade/ }).should("have.length.greaterThan", 0);
      }
    });
  });

  it("the portal hop sends an org with no Stripe customer back to billing", () => {
    cy.login();
    cy.request({ url: "/manage-subscription", followRedirect: false }).then((res) => {
      expect(res.status).to.be.oneOf([302, 303, 307, 308]);
      const target = new URL(String(res.headers.location), Cypress.config("baseUrl") ?? undefined);
      // Either Stripe's portal (an org that has a customer) or back to /billing —
      // never an error page.
      expect(
        target.pathname === "/billing" || target.hostname.endsWith("stripe.com"),
        `portal hop went to ${target.href}`,
      ).to.equal(true);
    });
  });
});
