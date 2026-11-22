// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RotateCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Root error boundary — the catch-all for any segment without its own `error.tsx`
 * (marketing, auth, account, and the operator console, whose layouts run async
 * server work that can throw). Without this, an uncaught error renders Next's
 * unstyled default page. (Errors thrown by the root layout itself need
 * `global-error.tsx`; this covers everything rendered inside it.)
 */
export default function RootError({
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
    <div
      role="alert"
      className="mx-auto flex min-h-dvh max-w-[520px] flex-col items-center justify-center px-6 text-center"
    >
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-[#f6e7df] text-danger">
        <TriangleAlert className="size-6" strokeWidth={1.7} />
      </div>
      <h1 className="text-xl font-bold tracking-[-0.02em]">Something went wrong</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        This is usually transient — try again, and if it persists, head back home and check in
        shortly.
      </p>
      <div className="mt-5 flex items-center gap-2.5">
        <Button onClick={reset}>
          <RotateCw className="size-4" strokeWidth={1.8} /> Try again
        </Button>
        <Button asChild variant="outline">
          <Link href="/">Go home</Link>
        </Button>
      </div>
    </div>
  );
}
