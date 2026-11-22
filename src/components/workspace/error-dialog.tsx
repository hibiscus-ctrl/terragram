// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ErrorDialog({
  open,
  onOpenChange,
  title,
  message,
  onRetry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <span className="flex size-9 items-center justify-center rounded-lg border border-warning-border bg-warning-bg text-warning">
            <AlertTriangle className="size-5" aria-hidden />
          </span>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Dismiss
          </Button>
          {onRetry && (
            <Button
              onClick={() => {
                onOpenChange(false);
                onRetry();
              }}
            >
              Try again
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
