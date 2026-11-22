import type * as React from "react";
import { AlertTriangle, Info, ShieldCheck } from "lucide-react";

import { cn } from "@/utils/cn";

type Tone = "note" | "caution" | "safe";

const tones: Record<
  Tone,
  { wrap: string; icon: React.ElementType; iconColor: string; title: string }
> = {
  note: {
    wrap: "border-info-border bg-info-bg",
    icon: Info,
    iconColor: "text-info",
    title: "Note",
  },
  caution: {
    wrap: "border-warning-border bg-warning-bg",
    icon: AlertTriangle,
    iconColor: "text-warning",
    title: "Caution",
  },
  safe: {
    wrap: "border-success-border bg-success-bg",
    icon: ShieldCheck,
    iconColor: "text-success",
    title: "Safe by default",
  },
};

/** Inline emphasis block for docs/legal copy. Not part of <Prose> spacing rules,
 *  so it carries its own margins. */
export function Callout({
  tone = "note",
  title,
  children,
  className,
}: {
  tone?: Tone;
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const t = tones[tone];
  const Icon = t.icon;
  return (
    <div className={cn("my-6 flex gap-3 rounded-xl border p-4", t.wrap, className)}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", t.iconColor)} strokeWidth={1.8} aria-hidden />
      <div className="min-w-0 text-sm leading-[1.6] text-ink-muted">
        <p className="mb-1 font-bold text-accent-foreground">{title ?? t.title}</p>
        {children}
      </div>
    </div>
  );
}
