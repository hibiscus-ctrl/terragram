"use client";

import { type ReactNode, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ROLE_LABEL, type OrgRole } from "@/features/account/controllers/permissions";
import { switchActiveOrg } from "@/features/app/active-org-actions";

type SwitchableOrg = { id: string; name: string; role: OrgRole };

/**
 * The caller's orgs, with the active one ticked; picking another makes it the
 * active org (an httpOnly cookie the server re-checks against their memberships on
 * every request) and re-renders the page for it. A page the new role may not open
 * redirects as usual. `children` is the trigger's content and its accessible name.
 */
export function OrgSwitcher({
  orgs,
  activeOrgId,
  className,
  children,
}: {
  orgs: SwitchableOrg[];
  activeOrgId: string | null;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function choose(orgId: string) {
    if (orgId === activeOrgId) return;
    startTransition(async () => {
      try {
        const res = await switchActiveOrg(orgId);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        router.refresh();
      } catch {
        toast.error("Could not switch organisation. Please try again.");
      }
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-busy={pending || undefined}
          disabled={pending}
          className={className}
        >
          {children}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px]">
        <DropdownMenuLabel className="text-2xs font-semibold text-muted-foreground">
          Organisations
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {orgs.map((org) => {
          const active = org.id === activeOrgId;
          return (
            <DropdownMenuItem
              key={org.id}
              onSelect={() => choose(org.id)}
              {...(active ? { "aria-current": "true" as const } : {})}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold">{org.name}</span>
                <span className="block text-2xs text-muted-foreground">{ROLE_LABEL[org.role]}</span>
              </span>
              {active && <Check className="size-4" aria-hidden />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
