// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { type ReactNode, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowLeft, GitBranch } from "lucide-react";
import { toast } from "sonner";

import { LogoMark } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  disconnectGitAction,
  type ProviderStatus,
  startGitConnectAction,
} from "@/features/git/actions";
import { saveSettingsAction } from "@/features/workspace/actions";
import { MANAGED_MODELS, type ManagedModelId } from "@/features/workspace/managed-models";
import { CLOUD_LABEL, MODE_LIST } from "@/features/workspace/modes";
import {
  DEFAULT_SETTINGS,
  type EdgeRouting,
  type LabelFace,
  type WorkspaceSettings as Settings,
} from "@/features/workspace/settings";
import { isWorkspaceMode } from "@/features/workspace/modes";

/**
 * Workspace settings.
 *
 * Every control here persists and changes something you can see. That was not true
 * before — the page was `useState` plus a "Settings saved" toast — and in a product
 * built on not doing things behind your back, a switch that lies is worse than no
 * switch. The old "stream responses" toggle is gone rather than reworded: there is no
 * progressive reveal for it to turn off.
 *
 * Each row says whether it applies to new workspaces or to all of them, because
 * "default mode" and "edge routing" behaving differently is exactly the kind of
 * quiet surprise that costs trust.
 */

function Scope({ scope }: { scope: "new" | "all" }) {
  return (
    <span className="mt-0.5 block font-mono text-2xs text-ink-faint">
      {scope === "new" ? "Applies to new workspaces" : "Applies everywhere, immediately"}
    </span>
  );
}

function Toggle({
  label,
  description,
  scope,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  scope: "new" | "all";
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-4 py-3.5">
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
        <Scope scope={scope} />
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 size-4 shrink-0 cursor-pointer rounded border-line-strong accent-primary"
      />
    </label>
  );
}

function Field({
  label,
  scope,
  children,
}: {
  label: string;
  scope: "new" | "all";
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3.5">
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">{label}</span>
        <Scope scope={scope} />
      </span>
      <div className="w-48 shrink-0">{children}</div>
    </div>
  );
}

/** Why a connection attempt came back, in words a person can act on. */
const GIT_ERROR_TEXT: Record<string, string> = {
  "unknown-provider": "That host is not one Terragram supports.",
  "not-configured": "That host is not configured on this deployment.",
  state: "The sign-in did not match the one started here. Try connecting again.",
  exchange: "The host did not issue a token. Check the app registration and try again.",
  store: "The token could not be stored. Check that GIT_TOKEN_ENCRYPTION_KEY is set.",
};

export function WorkspaceSettings({
  initial,
  git = [],
  gitNotice = null,
  managedInference = false,
  organisation = null,
}: {
  initial?: Settings;
  git?: ProviderStatus[];
  gitNotice?: { kind: "connected" | "error"; detail: string } | null;
  /** Whether managed turns actually happen in this deployment. The model choice is
   *  hidden when they don't: under the deterministic engine there is no model to
   *  pick, and a control that changes nothing is exactly the lie this page exists
   *  to avoid. */
  managedInference?: boolean;
  /** The caller's organisation panel (where leaving lives), rendered below the
   *  workspace defaults. Null when they belong to none. */
  organisation?: ReactNode;
}) {
  const [settings, setSettings] = useState<Settings>(initial ?? DEFAULT_SETTINGS);
  const [hosts, setHosts] = useState<ProviderStatus[]>(git);
  const [gitPending, startGit] = useTransition();

  function connect(provider: string) {
    startGit(async () => {
      const result = await startGitConnectAction(provider);
      if ("error" in result) {
        toast.error("Couldn’t start the connection", { description: result.error });
        return;
      }
      window.location.assign(result.url);
    });
  }

  function disconnect(provider: string) {
    startGit(async () => {
      const result = await disconnectGitAction(provider);
      if (!result.ok) {
        toast.error("Couldn’t disconnect");
        return;
      }
      setHosts((current) =>
        current.map((h) => (h.provider === provider ? { ...h, accountLogin: null } : h)),
      );
      toast.success("Disconnected", { description: "The stored token was deleted." });
    });
  }
  const [saved, setSaved] = useState<Settings>(initial ?? DEFAULT_SETTINGS);
  const [pending, startTransition] = useTransition();

  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);

  function patch(next: Partial<Settings>) {
    setSettings((current) => ({ ...current, ...next }));
  }

  function save() {
    startTransition(async () => {
      const result = await saveSettingsAction(settings);
      if (result.ok && result.settings) {
        setSaved(result.settings);
        setSettings(result.settings);
        toast.success("Settings saved");
      } else {
        toast.error("Couldn’t save settings", {
          description: "Your preferences need the workspace tables applied.",
        });
      }
    });
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center justify-between border-b border-line-strong px-4">
        <Link href="/workspace" className="flex items-center gap-2" aria-label="Terragram workspaces">
          <LogoMark />
          <span className="text-sm font-bold text-foreground">Terragram</span>
        </Link>
        <Button asChild variant="ghost" size="sm">
          <Link href="/workspace">
            <ArrowLeft className="size-4" aria-hidden /> Back to workspaces
          </Link>
        </Button>
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-2xl flex-1 px-6 py-10 outline-none"
      >
        <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-foreground">
          Workspace settings
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Defaults for how Terragram translates and draws. Each setting says where it takes effect.
        </p>

        <Tabs defaultValue="general" className="mt-7">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="diagramming">Diagramming</TabsTrigger>
            <TabsTrigger value="residency">Residency</TabsTrigger>
            <TabsTrigger value="integrations">Integrations</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="mt-5">
            <div className="divide-y divide-line rounded-xl border border-line-strong px-4">
              <Field label="Default mode" scope="new">
                <Select
                  value={settings.defaultMode}
                  onValueChange={(v) => isWorkspaceMode(v) && patch({ defaultMode: v })}
                  ariaLabel="Default mode"
                  options={MODE_LIST.map((m) => ({ value: m.id, label: m.title }))}
                />
              </Field>
              <Field label="Default cloud" scope="new">
                <Select
                  value={settings.defaultCloud}
                  onValueChange={(v) => patch({ defaultCloud: v === "aws" ? "aws" : "azure" })}
                  ariaLabel="Default cloud"
                  options={[
                    { value: "azure", label: CLOUD_LABEL.azure },
                    { value: "aws", label: CLOUD_LABEL.aws },
                  ]}
                />
              </Field>
              <Field label="Default generator" scope="new">
                <Select
                  value={settings.defaultTool}
                  onValueChange={(v) =>
                    patch({ defaultTool: v === "opentofu" ? "opentofu" : "terraform" })
                  }
                  ariaLabel="Default generator"
                  options={[
                    { value: "terraform", label: "Terraform" },
                    { value: "opentofu", label: "OpenTofu" },
                  ]}
                />
              </Field>
              <Toggle
                label="Ask before resolving ambiguity"
                description="Pause and ask a follow-up when a prompt could mean more than one thing. When off, Terragram picks the safer default and flags the node instead."
                scope="all"
                checked={settings.askAmbiguous}
                onChange={(v) => patch({ askAmbiguous: v })}
              />
              <Toggle
                label="Show starter suggestions"
                description="Offer example prompts in the empty compose state."
                scope="all"
                checked={settings.showSuggestions}
                onChange={(v) => patch({ showSuggestions: v })}
              />
              {managedInference ? (
                <Field label="Model" scope="all">
                  <Select
                    value={settings.inferenceModel}
                    onValueChange={(v) => patch({ inferenceModel: v as ManagedModelId })}
                    ariaLabel="Model"
                    options={MANAGED_MODELS.map((m) => ({ value: m.id, label: m.label }))}
                  />
                </Field>
              ) : null}
            </div>
          </TabsContent>

          <TabsContent value="diagramming" className="mt-5">
            <div className="divide-y divide-line rounded-xl border border-line-strong px-4">
              <Toggle
                label="Auto-layout"
                description="Re-route and refit the diagram as the model changes. When off, new components are placed below the existing ones and nothing else moves. A component you have dragged stays where you put it either way."
                scope="all"
                checked={settings.autoLayout}
                onChange={(v) => patch({ autoLayout: v })}
              />
              <Field label="Edge routing" scope="all">
                <Select
                  value={settings.edgeRouting}
                  onValueChange={(v) => patch({ edgeRouting: v as EdgeRouting })}
                  ariaLabel="Edge routing"
                  options={[
                    { value: "smoothstep", label: "Smooth step" },
                    { value: "step", label: "Orthogonal" },
                    { value: "straight", label: "Straight" },
                  ]}
                />
              </Field>
              <Field label="Label typeface" scope="all">
                <Select
                  value={settings.labelFace}
                  onValueChange={(v) => patch({ labelFace: v as LabelFace })}
                  ariaLabel="Label typeface"
                  options={[
                    { value: "mono", label: "Monospace" },
                    { value: "sans", label: "Sans-serif" },
                  ]}
                />
              </Field>
            </div>
          </TabsContent>

          <TabsContent value="residency" className="mt-5">
            <div className="rounded-xl border border-line-strong bg-card p-4">
              <h2 className="text-sm font-bold text-foreground">Where your data is handled</h2>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Terragram generates and stores in the UK. Diagrams, models and evidence receipts
                live in a UK-region database, and managed inference runs through a UK gateway.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                There is nothing to configure here, and that is the point: residency is a property
                of how Terragram is deployed, not a switch you can get wrong. A per-user residency
                choice would be a promise the architecture does not yet keep, so it is not offered.
              </p>
              <p className="mt-3 text-xs">
                <Link href="/docs/residency" className="text-primary underline underline-offset-2">
                  Read the residency documentation
                </Link>
              </p>
            </div>
          </TabsContent>

          <TabsContent value="integrations" className="mt-5">
            <div className="flex flex-col gap-3">
              {gitNotice && (
                <p
                  role="status"
                  className={
                    gitNotice.kind === "connected"
                      ? "rounded-xl border border-success-border bg-success-bg p-3 text-xs text-foreground"
                      : "rounded-xl border border-warning-border bg-warning-bg p-3 text-xs text-foreground"
                  }
                >
                  {gitNotice.kind === "connected"
                    ? `Connected to ${hosts.find((h) => h.provider === gitNotice.detail)?.label ?? gitNotice.detail}.`
                    : (GIT_ERROR_TEXT[gitNotice.detail] ?? "The connection did not complete.")}
                </p>
              )}
              {hosts.map((host) => (
                <div
                  key={host.provider}
                  className="flex items-center justify-between gap-4 rounded-xl border border-line-strong bg-card p-4"
                >
                  <span className="flex items-center gap-3">
                    <GitBranch className="size-5 text-foreground" aria-hidden />
                    <span>
                      <span className="block text-sm font-semibold text-foreground">{host.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {host.accountLogin
                          ? `Connected as @${host.accountLogin}. Pull requests are opened as you.`
                          : host.provider === "github"
                            ? "Open pull requests with the approved plan and its receipt."
                            : "Open merge requests with the approved plan and its receipt."}
                      </span>
                    </span>
                  </span>
                  {host.accountLogin ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => disconnect(host.provider)}
                      disabled={gitPending}
                    >
                      Disconnect
                    </Button>
                  ) : host.configured ? (
                    <Button size="sm" onClick={() => connect(host.provider)} disabled={gitPending}>
                      Connect
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" disabled>
                      Not configured
                    </Button>
                  )}
                </div>
              ))}
              <p className="text-xs leading-relaxed text-muted-foreground">
                A connection is yours alone: the token is stored sealed, is used only to open a
                change as you, and is deleted the moment you disconnect. A host marked "Not
                configured" has no app registered for this deployment, so no connection is offered.
              </p>
            </div>
          </TabsContent>
        </Tabs>

        <div className="mt-6 flex items-center justify-end gap-3">
          {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
          <Button onClick={save} disabled={!dirty || pending}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </div>

        {organisation}
      </main>
    </div>
  );
}
