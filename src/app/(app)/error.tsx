"use client";

import { useEffect } from "react";
import { RotateCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Segment error boundary for the dashboard. If a server query throws (e.g. the DB
 * is briefly unavailable), the user gets a recoverable state with a retry instead
 * of a crashed route. `reset()` re-renders the segment (re-runs the server fetch).
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="mx-auto max-w-[520px] px-8 py-24 text-center">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-[#f6e7df] text-danger">
        <TriangleAlert className="size-6" strokeWidth={1.7} />
      </div>
      <h1 className="text-xl font-bold tracking-[-0.02em]">Something went wrong</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        We couldn&rsquo;t load this view. This is usually transient — try again, and if it persists,
        check back shortly.
      </p>
      <Button onClick={reset} className="mt-5">
        <RotateCw className="size-4" strokeWidth={1.8} /> Try again
      </Button>
    </div>
  );
}
