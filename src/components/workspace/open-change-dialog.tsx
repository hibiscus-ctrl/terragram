"use client";

import { useState, useTransition } from "react";
import { GitPullRequest } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  gitProviderStatusAction,
  listGitRepositoriesAction,
  openChangeAction,
  type ProviderStatus,
  type RepositoryChoice,
} from "@/features/git/actions";
import type { EngineKind } from "@/features/workspace/engine";
import type { Cloud, InfraModel } from "@/features/workspace/model";
import type { TerraformTool } from "@/features/workspace/terraform";

/**
 * "Open pull request" after the review gate. The dialog asks only what the server
 * cannot decide — which host, which repository, which directory — and the server
 * rebuilds the plan and receipt from the approved model, so what lands on the host
 * is what was approved, not what the browser had.
 */
export function OpenChangeDialog({
  model,
  cloud,
  engine,
  tool,
  disabled,
}: {
  model: InfraModel;
  cloud: Cloud;
  engine: EngineKind;
  tool: TerraformTool;
  /** True until the review gate has been confirmed. */
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [provider, setProvider] = useState("");
  const [repositories, setRepositories] = useState<RepositoryChoice[]>([]);
  const [repository, setRepository] = useState("");
  const [directory, setDirectory] = useState("terraform");
  const [pending, startTransition] = useTransition();

  const connected = (providers ?? []).filter((p) => p.accountLogin);

  function load() {
    startTransition(async () => {
      const status = await gitProviderStatusAction();
      setProviders(status);
      const first = status.find((p) => p.accountLogin);
      if (first) choose(first.provider, status);
    });
  }

  function choose(next: string, status = providers ?? []) {
    setProvider(next);
    setRepository("");
    setRepositories([]);
    if (!status.some((p) => p.provider === next && p.accountLogin)) return;
    startTransition(async () => {
      const result = await listGitRepositoriesAction(next);
      if ("error" in result) {
        toast.error("Couldn’t list repositories", { description: result.error });
        return;
      }
      setRepositories(result.repositories);
    });
  }

  function submit() {
    startTransition(async () => {
      const result = await openChangeAction({ provider, repository, directory, model, cloud, engine, tool });
      if ("error" in result) {
        toast.error("Couldn’t open the change", { description: result.error });
        return;
      }
      setOpen(false);
      toast.success(`Opened ${result.noun} #${result.change.number}`, {
        description: `Branch ${result.change.branch} — the receipt is committed beside the plan.`,
        action: { label: "View", onClick: () => window.open(result.change.url, "_blank", "noopener") },
        duration: 12_000,
      });
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && providers === null) load();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full" disabled={disabled}>
          <GitPullRequest className="size-4" aria-hidden /> Open pull request
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Open a pull request</DialogTitle>
          <DialogDescription>
            One commit on a new branch: the plan files and the evidence receipt beside them. Nothing
            is applied.
          </DialogDescription>
        </DialogHeader>

        {providers !== null && connected.length === 0 ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            No Git host is connected.{" "}
            <Link href="/workspace/settings" className="text-primary underline underline-offset-2">
              Connect GitHub or GitLab in settings
            </Link>
            , then come back — the approved plan stays here.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span id="open-change-host" className="text-sm font-semibold text-foreground">
                Host
              </span>
              <Select
                id="open-change-host-select"
                value={provider}
                onValueChange={(v) => choose(v)}
                options={connected.map((p) => ({ value: p.provider, label: `${p.label} · @${p.accountLogin}` }))}
                ariaLabel="Git host"
                disabled={pending || connected.length === 0}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span id="open-change-repository" className="text-sm font-semibold text-foreground">
                Repository
              </span>
              <Select
                id="open-change-repository-select"
                value={repository}
                onValueChange={setRepository}
                options={repositories.map((r) => ({ value: r.id, label: r.label, ...(r.hint ? { hint: r.hint } : {}) }))}
                ariaLabel="Repository"
                placeholder={pending && repositories.length === 0 ? "Loading…" : "Choose a repository"}
                disabled={pending || repositories.length === 0}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="open-change-directory" className="text-sm font-semibold text-foreground">
                Directory
              </label>
              <Input
                id="open-change-directory"
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                placeholder="terraform"
                aria-describedby="open-change-directory-hint"
              />
              <span id="open-change-directory-hint" className="text-xs text-muted-foreground">
                Where the files are committed. Existing files at these paths are replaced in the
                branch, never on the default branch.
              </span>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !provider || !repository}>
            {pending ? "Working…" : "Open pull request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
