"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

import { MARKETING_NAV } from "@/components/site-nav";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/utils/cn";

/**
 * Marketing/global navigation for small screens — a hamburger that opens a
 * left-side Sheet with the same {@link MARKETING_NAV} links the desktop header
 * shows inline. Rendered everywhere the {@link SiteHeader} is, so phone visitors
 * can always reach Features / Pricing / Docs / About. Hidden at `md` and up,
 * where the inline nav takes over.
 */
export function MobileMenu() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Open menu"
          className="inline-flex size-10 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none md:hidden"
        >
          <Menu className="size-5" aria-hidden />
        </button>
      </SheetTrigger>
      <SheetContent side="left" className="w-[280px] p-0">
        <SheetHeader className="border-b border-border px-5 py-4 text-left">
          <SheetTitle>Menu</SheetTitle>
        </SheetHeader>
        <nav className="flex flex-col gap-0.5 p-3">
          {MARKETING_NAV.map((link) => {
            const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            const linkClass = (isActive: boolean) =>
              cn(
                "rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors",
                isActive
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              );

            if (link.children) {
              // Parent link, then its children indented under a rule so the MCP
              // (and other) doc pages are reachable directly from the phone menu.
              return (
                <div key={link.href} className="flex flex-col gap-0.5">
                  <Link
                    href={link.href}
                    onClick={() => setOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={linkClass(active)}
                  >
                    {link.label}
                  </Link>
                  <div className="ml-3 flex flex-col gap-0.5 border-l border-border pl-2">
                    {link.children.map((child) => {
                      const childActive = pathname === child.href;
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          onClick={() => setOpen(false)}
                          aria-current={childActive ? "page" : undefined}
                          className={cn(
                            "rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                            childActive
                              ? "bg-secondary text-foreground"
                              : "text-muted-foreground hover:bg-accent hover:text-foreground",
                          )}
                        >
                          {child.label}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            }

            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                aria-current={active ? "page" : undefined}
                className={linkClass(active)}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
