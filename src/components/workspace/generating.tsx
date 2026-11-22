// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Cloud } from "@/features/workspace/model";
import { CLOUD_LABEL } from "@/features/workspace/modes";

/**
 * The generating screen shown between the review gate and the result while the
 * signed evidence receipt is built. The steps are indicative (the plan itself is
 * deterministic), so this is a short, honest progress cue rather than a fake delay —
 * it advances as fast as `prefers-reduced-motion` allows.
 */
export function GeneratingScreen({ cloud, provider }: { cloud: Cloud; provider: string }) {
  const steps = useMemo(
    () => [
      "Compiling internal model",
      `Mapping to the ${provider} provider`,
      "Writing Terraform modules",
      "Signing evidence bundle",
    ],
    [provider],
  );
  const [active, setActive] = useState(0);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setActive(steps.length);
      return;
    }
    const timers = steps.map((_, i) => setTimeout(() => setActive(i + 1), (i + 1) * 260));
    return () => timers.forEach(clearTimeout);
  }, [steps]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
      <Loader2 className="size-8 animate-spin text-primary" aria-hidden />
      <div>
        <p className="text-xl font-bold text-foreground">
          Generating {CLOUD_LABEL[cloud]} infrastructure…
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Compiling the internal model into Terraform
        </p>
      </div>
      <ul className="flex w-full max-w-xs flex-col gap-2.5 text-left" aria-label="Generation steps">
        {steps.map((step, i) => {
          const done = i < active;
          return (
            <li key={step} className="flex items-center gap-2.5 text-sm text-ink-soft">
              <span
                className={
                  done
                    ? "flex size-4 items-center justify-center rounded-full bg-success text-[9px] font-bold text-white"
                    : "size-4 rounded-full border border-line-strong"
                }
                aria-hidden
              >
                {done ? "✓" : ""}
              </span>
              {step}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Generation-timeout recovery. Nothing was applied, so the two exits are back to the
 * review gate (edit the model) or retry.
 */
export function GenerationTimeout({
  cloud,
  onBackToReview,
  onRetry,
}: {
  cloud: Cloud;
  onBackToReview: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-warning-bg" aria-hidden>
        <AlertTriangle className="size-6 text-warning" />
      </span>
      <div>
        <p className="text-xl font-bold text-foreground">Generation timed out</p>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-soft">
          The {CLOUD_LABEL[cloud]} provider API didn’t respond within 30 seconds{" "}
          <span className="font-mono text-xs text-muted-foreground">(504 Gateway Timeout)</span>.
        </p>
        <p className="mt-2 text-sm font-semibold text-success">
          Your model is safe — nothing was applied.
        </p>
      </div>
      <div className="flex gap-2.5">
        <Button variant="outline" onClick={onBackToReview}>
          Back to review
        </Button>
        <Button onClick={onRetry}>Retry generation</Button>
      </div>
    </div>
  );
}
