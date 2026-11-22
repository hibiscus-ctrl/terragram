// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { type FormEvent, useState } from "react";
import { CornerDownLeft } from "lucide-react";

import { COMPOSE_SUGGESTIONS } from "@/features/workspace/samples";
import type { WorkspaceMode } from "@/features/workspace/modes";
import { cn } from "@/utils/cn";
import { LogoMark } from "@/components/logo";
import { ModeMenu } from "./mode-menu";
import type { ChatMessage } from "./types";

export function ComposePane({
  mode,
  onModeChange,
  messages,
  onSend,
  busy = false,
  inferenceMode,
  showSuggestions = true,
}: {
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
  messages: ChatMessage[];
  onSend: (text: string) => void;
  busy?: boolean;
  /** Honest label of the translator that answers ("Managed · UK Bedrock" or
   *  "Deterministic · local"). */
  inferenceMode: string;
  showSuggestions?: boolean;
}) {
  const [value, setValue] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue("");
  }

  const empty = messages.length === 0;

  return (
    <div className="flex h-full flex-col">
      <PaneHeader
        title="Compose"
        subtitle="Refine the model in plain English"
        mode={mode}
        onModeChange={onModeChange}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        {empty ? (
          <div className="mx-auto flex max-w-sm flex-col items-center gap-2 pt-10 text-center">
            <LogoMark className="size-10 rounded-xl text-sm" />
            <h2 className="mt-2 text-base font-bold text-foreground">Describe your architecture</h2>
            <p className="text-sm text-muted-foreground">Start with a sentence, then refine.</p>
            <p className="text-xs font-medium text-ink-faint">Try one of these:</p>
            <div className="mt-2 flex w-full flex-col gap-2">
              {(showSuggestions ? COMPOSE_SUGGESTIONS : []).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onSend(s)}
                  disabled={busy}
                  className="rounded-lg border border-line-strong bg-card px-3.5 py-3 text-left text-sm text-ink-soft transition-colors hover:border-input hover:bg-surface-subtle focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-4">
            {messages.map((m) => (
              <li key={m.id}>
                {m.role === "user" ? (
                  <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-tr-sm bg-foreground px-3.5 py-2.5 text-sm text-background">
                    {m.text}
                  </div>
                ) : (
                  <div className="flex gap-2.5">
                    <LogoMark className="mt-0.5 size-7 shrink-0 rounded-md text-[10px]" />
                    <div className="min-w-0">
                      <p className="text-sm leading-relaxed text-ink-soft">{m.text}</p>
                      {m.options && m.options.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {m.options.map((opt) => (
                            <button
                              key={opt}
                              type="button"
                              onClick={() => onSend(opt)}
                              disabled={busy}
                              className="rounded-lg border border-line-strong bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-input hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none disabled:opacity-50"
                            >
                              {opt}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {m.flags ? (
                        <span className="mt-2 inline-flex items-center rounded-md border border-warning-border bg-warning-bg px-2 py-1 font-mono text-2xs font-semibold text-warning">
                          {m.flags} {m.flags === 1 ? "node" : "nodes"} flagged for review
                        </span>
                      ) : null}
                    </div>
                  </div>
                )}
              </li>
            ))}
            {busy && (
              <li className="flex gap-2.5" aria-live="polite">
                <LogoMark className="mt-0.5 size-7 shrink-0 rounded-md text-[10px]" />
                <span className="flex items-center gap-1 pt-1.5">
                  <span className="sr-only">Terragram is translating your description</span>
                  <span className="size-1.5 animate-bounce rounded-full bg-ink-faint [animation-delay:-0.2s]" aria-hidden />
                  <span className="size-1.5 animate-bounce rounded-full bg-ink-faint [animation-delay:-0.1s]" aria-hidden />
                  <span className="size-1.5 animate-bounce rounded-full bg-ink-faint" aria-hidden />
                </span>
              </li>
            )}
          </ul>
        )}
      </div>

      <form onSubmit={submit} className="shrink-0 border-t border-line-strong p-3">
        <div className="rounded-xl border border-line-strong bg-card focus-within:border-input">
          <label htmlFor="compose-input" className="sr-only">
            Describe your architecture
          </label>
          <textarea
            id="compose-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) submit(e);
            }}
            rows={2}
            disabled={busy}
            placeholder="Add a Redis cache to the web tier…"
            className="w-full resize-none rounded-t-xl bg-transparent px-3.5 py-3 text-sm text-foreground outline-none placeholder:text-ink-faint disabled:opacity-60"
          />
          <div className="flex items-center justify-between px-3 pb-2.5">
            <span className="font-mono text-2xs text-ink-faint">model · {inferenceMode}</span>
            <button
              type="submit"
              disabled={!value.trim() || busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background transition-opacity hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none disabled:opacity-40"
            >
              Send <CornerDownLeft className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

export function PaneHeader({
  title,
  subtitle,
  mode,
  onModeChange,
}: {
  title: string;
  subtitle: string;
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
}) {
  return (
    <div className="flex shrink-0 items-start justify-between gap-2 border-b border-line-strong px-4 py-3">
      <div className="min-w-0">
        <h1 className={cn("text-sm font-bold text-foreground")}>{title}</h1>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <ModeMenu mode={mode} onChange={onModeChange} />
    </div>
  );
}
