import { cn } from "@/utils/cn";

/**
 * The "Demo data" pill shown on dashboard surfaces (repositories, repo detail,
 * billing) when sample data is rendered for an org with no real reports yet.
 *
 * Centralised so the warm chip + text stay one source of truth — and so the text
 * uses the semantic `muted-foreground` token (≈5.3:1 on the chip) rather than the
 * old ad-hoc `#9a8a6f` (~3:1, which failed WCAG AA for this 11px text).
 */
export function DemoBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-line-strong bg-surface-code px-2 py-0.5 text-2xs font-semibold text-muted-foreground",
        className,
      )}
    >
      Demo data
    </span>
  );
}
