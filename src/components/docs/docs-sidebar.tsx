"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { docsNav } from "@/config/navigation";
import { cn } from "@/utils/cn";

/** Persistent docs navigation with active-state highlighting. */
export function DocsSidebar() {
  const pathname = usePathname();

  return (
    <nav aria-label="Documentation" className="flex flex-col gap-6">
      {docsNav.map((section) => (
        <div key={section.title}>
          <h2 className="mb-2 px-3 text-2xs font-bold tracking-[0.08em] text-muted-foreground uppercase">
            {section.title}
          </h2>
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block rounded-md px-3 py-1.5 text-xs transition-colors",
                      active
                        ? "bg-surface-sunken font-semibold text-primary"
                        : "font-medium text-ink-soft hover:bg-wash hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
