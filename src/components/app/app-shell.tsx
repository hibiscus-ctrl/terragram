"use client";

import { type PropsWithChildren, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsUpDown, CreditCard, type LucideIcon, Menu, Settings, Users } from "lucide-react";

import { OrgSwitcher } from "@/components/app/org-switcher";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { type Capability, can, type OrgRole } from "@/features/account/controllers/permissions";
import { cn } from "@/utils/cn";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** The capability the page's `guardPage` requires; the entry shows only to a role
   *  that has it, so the nav never offers a page that would redirect away. */
  capability: Capability;
  exact?: boolean;
};

// The centred column shared by the header, app body and footer so all three line up.
const SHELL_WIDTH = "max-w-[1320px]";

// Terragram's account area is billing, members and settings until the workspace lands
// (Phase 4 rebuilds this shell around the diagram workspace).
const ACCOUNT_NAV: NavItem[] = [
  { label: "Billing", href: "/billing", icon: CreditCard, capability: "billing.manage" },
  { label: "Members", href: "/members", icon: Users, capability: "members.manage" },
  { label: "Settings", href: "/settings", icon: Settings, capability: "org.settings" },
];

/** The entries `role` may open, from the capability matrix. No role, no entries. */
function navFor(role: OrgRole | null): NavItem[] {
  return role ? ACCOUNT_NAV.filter((item) => can(role, item.capability)) : [];
}

export type OrgChip = { name: string; plan: string };
export type UserChip = { name: string; subtitle: string; initials: string };
export type OrgSwitcherItem = { id: string; slug: string; name: string; role: OrgRole; plan: string };

// Neutral placeholder — the layout always passes the real org; this only guards
// against an unexpected null.
const FALLBACK_ORG: OrgChip = { name: "Your account", plan: "—" };

const CHIP_CLASS =
  "bg-card mx-3 mt-4 mb-3.5 flex items-center gap-2.5 rounded-lg border border-line-strong px-2.5 py-2";

function ChipBody({ org }: { org: OrgChip }) {
  return (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground text-2xs font-bold text-background uppercase">
        {org.name.charAt(0)}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-xs font-semibold">{org.name}</span>
        <span className="block text-2xs text-muted-foreground">{org.plan}</span>
      </span>
    </>
  );
}

/** The org chip in the sidebar: the org menu when the user belongs to more than
 *  one org, a read-only chip otherwise. */
function AccountChip({
  org,
  orgs,
  activeOrgId,
}: {
  org: OrgChip;
  orgs: OrgSwitcherItem[];
  activeOrgId: string | null;
}) {
  if (orgs.length < 2) {
    return (
      <div className={CHIP_CLASS}>
        <ChipBody org={org} />
      </div>
    );
  }
  return (
    <OrgSwitcher
      orgs={orgs}
      activeOrgId={activeOrgId}
      className={cn(
        CHIP_CLASS,
        "w-[calc(100%-1.5rem)] transition-colors hover:bg-surface-sunken focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none",
      )}
    >
      <span className="sr-only">Switch organisation, current:</span>
      <ChipBody org={org} />
      <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </OrgSwitcher>
  );
}

/** Whether `item` is the section the current path is in. */
function isActive(item: NavItem, pathname: string): boolean {
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/**
 * Defined at module scope, not inside {@link AppShell}.
 *
 * A component declared during render is a NEW component type on every render, so
 * React unmounts the previous tree and mounts a fresh one instead of updating it.
 * For the nav that meant losing keyboard focus and restarting `transition-colors`
 * every time the mobile sheet opened or the route changed.
 */
function NavLink({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: (() => void) | undefined;
}) {
  const active = isActive(item, pathname);
  return (
    <Link
      href={item.href}
      {...(onNavigate ? { onClick: onNavigate } : {})}
      {...(active ? { "aria-current": "page" as const } : {})}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-semibold transition-colors",
        active
          ? "bg-surface text-surface-foreground"
          : "text-ink-soft hover:bg-surface-sunken hover:text-accent-foreground",
      )}
    >
      <item.icon className="size-4" strokeWidth={1.7} aria-hidden />
      {item.label}
    </Link>
  );
}

function Nav({
  items,
  pathname,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <>
      {items.map((item) => (
        <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
      ))}
    </>
  );
}

export function AppShell({
  children,
  org = FALLBACK_ORG,
  orgs = [],
  activeOrgId = null,
  orgRole = null,
}: PropsWithChildren<{
  org?: OrgChip | undefined;
  /** Every org the user belongs to — the org menu's list. */
  orgs?: OrgSwitcherItem[] | undefined;
  activeOrgId?: string | null | undefined;
  /** The caller's role in the active org; the nav shows what it may open. */
  orgRole?: OrgRole | null | undefined;
}>) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);

  // The active org's pages, filtered by the caller's capabilities (no org slug).
  const navItems = navFor(orgRole);

  const currentLabel = navItems.find((item) => isActive(item, pathname))?.label ?? "Account";

  return (
    <div className="bg-background flex min-h-dvh flex-col">
      <SiteHeader widthClass={SHELL_WIDTH} />

      <div className={cn("mx-auto flex w-full flex-1", SHELL_WIDTH)}>
        <aside className="hidden w-[230px] shrink-0 self-stretch border-r border-line-strong md:block">
          <div className="sticky top-16 flex max-h-[calc(100dvh-4rem)] flex-col overflow-y-auto">
            <AccountChip org={org} orgs={orgs} activeOrgId={activeOrgId} />
            <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-4">
              <Nav items={navItems} pathname={pathname} />
            </nav>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2.5 border-b border-line-strong px-4 py-2.5 md:hidden">
            <Sheet open={navOpen} onOpenChange={setNavOpen}>
              <SheetTrigger asChild>
                <button
                  type="button"
                  aria-label="Open navigation"
                  className="inline-flex size-9 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
                >
                  <Menu className="size-5" aria-hidden />
                </button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[280px] p-0">
                <SheetHeader className="sr-only">
                  <SheetTitle>Account navigation</SheetTitle>
                </SheetHeader>
                <AccountChip org={org} orgs={orgs} activeOrgId={activeOrgId} />
                <nav className="flex flex-col gap-0.5 px-3 pb-4">
                  <Nav
                    items={navItems}
                    pathname={pathname}
                    onNavigate={() => setNavOpen(false)}
                  />
                </nav>
              </SheetContent>
            </Sheet>
            <span className="text-sm font-semibold">{currentLabel}</span>
          </div>

          <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 outline-none">
            {children}
          </main>
        </div>
      </div>

      <SiteFooter widthClass={SHELL_WIDTH} />
    </div>
  );
}
