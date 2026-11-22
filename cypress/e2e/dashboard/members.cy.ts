// Team management: the Members page, an invite created, shared and accepted by
// link, a role change that makes the invitee an Admin (so Settings can hand the
// org to them), a removal, and a revoked invite.
//
// WRITES ROWS in the e2e user's org: a membership and invites for `e2e-invitee*`
// addresses. `cleanupTeam` removes them in before() and after(), so a run that
// crashed half-way leaves nothing behind for the next one, and a stale pending
// invite cannot auto-join the invitee at their next sign-in.

const INVITEE = Cypress.expose("E2E_INVITEE_EMAIL") as string;
const INVITEE_PASSWORD = Cypress.expose("E2E_INVITEE_PASSWORD") as string;
const REVOKED = "e2e-invitee-revoked@terragram.dev";

/** The members table row for `email`. */
const memberRow = (email: string) => cy.findByRole("table", { name: /^Members of / }).contains("tr", email);

describe("Members and invites", () => {
  let invitePath = "";

  before(() => {
    // The invitee exists and holds a session BEFORE any invite does, so the link,
    // not the email match at sign-in, is what lets them in.
    cy.login(INVITEE, INVITEE_PASSWORD);
    cy.task("cleanupTeam");
  });

  after(() => {
    cy.task("cleanupTeam");
  });

  it("lists the signed-in Admin on the Members page", () => {
    cy.login();
    cy.visit("/members");
    cy.findByRole("heading", { level: 1, name: "Members" }).should("be.visible");
    cy.findByRole("table", { name: /^Members of / }).within(() => {
      cy.findByText("You").should("be.visible");
    });
    // An Admin holds members.manage, so the sidebar offers the page.
    cy.get("aside nav").findByRole("link", { name: "Members" }).should("have.attr", "href", "/members");
  });

  it("creates an invite and shows its link once", () => {
    cy.login();
    cy.visit("/members");
    cy.hydrated("main button");
    cy.clickUntil('[role="dialog"]', () => cy.findByRole("button", { name: "Invite member" }).click());
    cy.findByLabelText("Email address").type(INVITEE);
    cy.findByRole("button", { name: "Create invite" }).click();
    cy.findByLabelText("Invite link")
      .invoke("val")
      .then((link) => {
        const url = new URL(String(link));
        expect(url.pathname).to.match(/^\/invite\/[\w-]{20,}$/);
        invitePath = url.pathname;
      });
    cy.findByRole("button", { name: "Done" }).click();
    cy.findByRole("table", { name: "Pending invitations" }).should("contain.text", INVITEE);
  });

  it("shows a signed-out visitor the invite and sends them to sign in with the link kept", () => {
    cy.visit(invitePath);
    cy.location("pathname").should("eq", invitePath);
    cy.findByRole("heading", { level: 1, name: /^Join / }).should("be.visible");
    cy.findByRole("link", { name: "Sign in to accept" })
      .should("have.attr", "href", `/login?next=${encodeURIComponent(invitePath)}`);

    // Signing up keeps the link too, and the sign-up page passes it on (its
    // "Sign in" link, and the confirmation that the server remembers).
    cy.get("main")
      .findByRole("link", { name: "Create an account" })
      .should("have.attr", "href", `/signup?next=${encodeURIComponent(invitePath)}`)
      .click();
    cy.location("pathname").should("eq", "/signup");
    cy.get("main")
      .findByRole("link", { name: "Sign in" })
      .should("have.attr", "href", `/login?next=${encodeURIComponent(invitePath)}`);
  });

  it("an unknown invite link is reachable signed out and says so", () => {
    cy.visit("/invite/not-a-real-token");
    cy.location("pathname").should("eq", "/invite/not-a-real-token");
    cy.findByRole("heading", { level: 1, name: "Invitation not found" }).should("be.visible");
  });

  it("the invitee accepts by link and lands in the workspace", () => {
    cy.login(INVITEE, INVITEE_PASSWORD);
    cy.visit(invitePath);
    cy.hydrated("main button");
    cy.findByRole("button", { name: "Accept invitation" }).click();
    cy.location("pathname", { timeout: 20000 }).should("eq", "/workspace");

    // The link is spent; reopening it says they are already in.
    cy.visit(invitePath);
    cy.findByRole("heading", { level: 1, name: /^You're in / }).should("be.visible");

    // Accepting made the joined org the active one, and the invitee (now in their
    // own org and this one) can switch from Workspace settings, which any role opens.
    cy.findByRole("heading", { level: 1, name: /^You're in / })
      .invoke("text")
      .then((heading) => {
        const orgLabel = heading.replace(/^You're in /, "").trim();
        cy.visit("/workspace/settings");
        cy.findByRole("region", { name: "Organisation" }).within(() => {
          cy.contains(orgLabel).should("be.visible");
          cy.findByRole("button", { name: /Switch organisation/ }).should("be.visible");
        });
      });
  });

  it("an Admin makes the invitee an Admin, so Settings can hand the org over", () => {
    cy.login();
    cy.visit("/members");
    memberRow(INVITEE).within(() => cy.hydrated("button"));
    cy.clickUntil('[role="menu"]', () => memberRow(INVITEE).find('button[aria-label^="Manage "]').click());
    cy.findByRole("menuitem", { name: /^Admin/ }).click();
    memberRow(INVITEE).should("contain.text", "Admin");

    cy.visit("/settings");
    cy.findByRole("button", { name: "Transfer" }).should("not.be.disabled");
  });

  it("an Admin removes the invitee", () => {
    cy.login();
    cy.visit("/members");
    memberRow(INVITEE).within(() => cy.hydrated("button"));
    cy.clickUntil('[role="menu"]', () => memberRow(INVITEE).find('button[aria-label^="Manage "]').click());
    cy.findByRole("menuitem", { name: /Remove from organisation/ }).click();
    cy.findByRole("dialog").within(() => cy.findByRole("button", { name: "Remove member" }).click());
    cy.findByRole("table", { name: /^Members of / }).should("not.contain.text", INVITEE);
  });

  it("an Admin revokes a pending invite", () => {
    cy.login();
    cy.visit("/members");
    cy.hydrated("main button");
    cy.clickUntil('[role="dialog"]', () => cy.findByRole("button", { name: "Invite member" }).click());
    cy.findByLabelText("Email address").type(REVOKED);
    cy.findByRole("button", { name: "Create invite" }).click();
    cy.findByLabelText("Invite link").should("be.visible");
    cy.findByRole("button", { name: "Done" }).click();

    cy.findByRole("button", { name: `Revoke the invite for ${REVOKED}` }).click();
    cy.findByRole("dialog").within(() => cy.findByRole("button", { name: "Revoke invite" }).click());
    cy.contains(REVOKED).should("not.exist");
  });
});
