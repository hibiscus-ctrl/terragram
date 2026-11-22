// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type * as React from "react";

import { cn } from "@/utils/cn";

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-semibold text-foreground select-none",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
