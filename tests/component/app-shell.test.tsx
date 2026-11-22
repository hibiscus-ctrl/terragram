/** @jsxRuntime automatic @jsxImportSource react */
import "./setup.ts";

import assert from "node:assert/strict";
import { afterEach, before, describe, it, mock } from "node:test";

import { cleanup, render, screen } from "@testing-library/react";

/**
 * The regression this file exists for.
 *
 * `NavLink` and `Nav` used to be declared INSIDE `AppShell`. A component declared
 * during render is a new component type on every render, so React unmounts the old
 * tree and mounts a fresh one instead of updating it — the nav lost keyboard focus
 * and restarted its colour transitions every time the route changed or the mobile
 * sheet opened. oxlint's `no-unstable-nested-components` caught it; this keeps it
 * caught, because the symptom (focus quietly moving to `<body>`) is exactly the
 * kind of thing that survives review.
 *
 * The assertions are on DOM NODE IDENTITY and on focus, because those are the
 * precise consequences: a remount replaces the element, so a held reference goes
 * stale and whatever the user had focused is gone.
 */

const PATHNAME = "/billing";

// The marketing chrome reaches server-only modules, which a client-side render
// cannot import. It contributes nothing to the nav, so it is stubbed rather than
// worked around.
mock.module("@/components/site-header", { namedExports: { SiteHeader: () => null } });
mock.module("@/components/site-footer", { namedExports: { SiteFooter: () => null } });
mock.module("next/navigation", { namedExports: { usePathname: () => PATHNAME } });
// The org menu calls a server action; only whether the shell offers it matters here.
mock.module("@/components/app/org-switcher", {
  namedExports: {
    OrgSwitcher: ({ children }: { children: React.ReactNode }) => (
      <button type="button" data-testid="org-switcher">
        {children}
      </button>
    ),
  },
});

type AppShellModule = typeof import("../../src/components/app/app-shell.tsx");
let AppShell: AppShellModule["AppShell"];

before(async () => {
  ({ AppShell } = await import("../../src/components/app/app-shell.tsx"));
});

afterEach(() => {
  cleanup();
});

describe("AppShell nav", () => {
  it("renders the account navigation", () => {
    render(<AppShell orgRole="admin">content</AppShell>);
    assert.ok(screen.getAllByRole("link").length > 0, "nav should contain links");
  });

  it("keeps the same DOM nodes across a re-render", () => {
    const { rerender } = render(<AppShell orgRole="admin">first</AppShell>);
    const before = screen.getAllByRole("link")[0];

    rerender(<AppShell orgRole="admin">second</AppShell>);
    const after = screen.getAllByRole("link")[0];

    // Identity, not equality: had the nav components been re-created during render,
    // React would have torn these nodes down and built new ones.
    assert.equal(before, after, "nav link was remounted instead of updated");
  });

  it("keeps focus on a nav link across a re-render", () => {
    const { rerender } = render(<AppShell orgRole="admin">first</AppShell>);
    const link = screen.getAllByRole("link")[0] as HTMLElement;
    link.focus();
    assert.equal(document.activeElement, link, "precondition: the link is focused");

    rerender(<AppShell orgRole="admin">second</AppShell>);

    // The user-visible symptom of the remount: focus falls back to <body>.
    assert.equal(document.activeElement, link, "focus was lost when the nav remounted");
  });

  it("marks exactly one section as current", () => {
    render(<AppShell orgRole="admin">content</AppShell>);
    const current = screen
      .getAllByRole("link")
      .filter((el) => el.getAttribute("aria-current") === "page");
    assert.equal(current.length, 1, `expected one aria-current link, got ${current.length}`);
    assert.equal(current[0]?.getAttribute("href"), PATHNAME);
  });
});

describe("AppShell org menu", () => {
  const ORGS = [
    { id: "org-a", slug: "acme", name: "Acme", role: "admin" as const, plan: "free" },
    { id: "org-b", slug: "beta", name: "Beta", role: "maintainer" as const, plan: "payg" },
  ];

  it("offers the org menu to a member of several orgs", () => {
    render(
      <AppShell orgs={ORGS} activeOrgId="org-a">
        content
      </AppShell>,
    );
    assert.ok(screen.getAllByTestId("org-switcher").length > 0);
  });

  it("shows a read-only chip to a member of one org", () => {
    render(
      <AppShell orgs={ORGS.slice(0, 1)} activeOrgId="org-a">
        content
      </AppShell>,
    );
    assert.equal(screen.queryAllByTestId("org-switcher").length, 0);
  });
});

describe("AppShell nav filtering", () => {
  // The sidebar is the dashboard rendered twice (desktop aside, mobile sheet), so
  // compare the set of destinations, not the count of links.
  const destinations = () => [...new Set(screen.queryAllByRole("link").map((el) => el.getAttribute("href")))].sort();

  it("shows an Admin every account page", () => {
    render(<AppShell orgRole="admin">content</AppShell>);
    assert.deepEqual(destinations(), ["/billing", "/members", "/settings"]);
  });

  it("shows a Billing Manager Billing alone — no Members, no Settings", () => {
    render(<AppShell orgRole="billing_manager">content</AppShell>);
    assert.deepEqual(destinations(), ["/billing"]);
  });

  it("shows a role without any dashboard capability no entries at all", () => {
    for (const role of ["maintainer", "auditor"] as const) {
      render(<AppShell orgRole={role}>content</AppShell>);
      assert.deepEqual(destinations(), [], role);
      cleanup();
    }
    render(<AppShell>content</AppShell>);
    assert.deepEqual(destinations(), []);
  });
});
