import Link from "next/link";

import { HeaderActions } from "@/components/header-actions";
import { Logo } from "@/components/logo";
import { MobileMenu } from "@/components/mobile-menu";
import { NavDropdown } from "@/components/nav-dropdown";
import { MARKETING_NAV } from "@/components/site-nav";
import { cn } from "@/utils/cn";

/**
 * The single, centralised site header — used by every layout (marketing, auth,
 * dashboard). Left: logo + primary nav. Right: the shared {@link HeaderActions}
 * (GitHub, dashboard/login, profile menu). `widthClass` sets the centred content
 * column so the bar lines up with the page beneath it (1180px marketing column,
 * wider on the dashboard); the full-bleed bar (border + background) always spans
 * the viewport.
 */
export function SiteHeader({ widthClass = "max-w-page" }: { widthClass?: string }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-md">
      <div
        className={cn("mx-auto flex h-16 items-center justify-between px-4 sm:px-7", widthClass)}
      >
        <div className="flex items-center gap-2 md:gap-10">
          <MobileMenu />
          <Logo />
          <nav className="hidden items-center gap-6 text-sm font-medium text-muted-foreground md:flex">
            {MARKETING_NAV.map((link) =>
              link.children ? (
                <NavDropdown key={link.label} label={link.label} items={link.children} />
              ) : (
                <Link
                  key={link.label}
                  href={link.href}
                  className="transition-colors hover:text-primary"
                >
                  {link.label}
                </Link>
              ),
            )}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <HeaderActions />
        </div>
      </div>
    </header>
  );
}
