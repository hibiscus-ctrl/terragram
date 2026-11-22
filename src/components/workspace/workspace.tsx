"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { toast } from "sonner";

import { LogoMark } from "@/components/logo";

import { signOut } from "@/app/(auth)/auth-actions";
import {
  generateEvidenceAction,
  listReceiptsAction,
  saveWorkspaceAction,
  updateWorkspaceAction,
} from "@/features/workspace/actions";
import { composeFromPrompt, type ComposeResult, type EngineKind } from "@/features/workspace/engine";
import { assessFeasibility } from "@/features/workspace/feasibility";
import { buildEvidence, inferenceModeLabel } from "@/features/workspace/evidence";
import { explainModel } from "@/features/workspace/explain";
import {
  addNode,
  connectNodes,
  removeEdges,
  removeNodes,
  resolveNodeFlag,
  setNodeAttribute,
  setNodeLabel,
  setNodePosition,
} from "@/features/workspace/inspector";
import { kindDefinition } from "@/features/workspace/kinds";
import {
  type Cloud,
  countFlags,
  EMPTY_MODEL,
  type InfraModel,
  type NodeCategory,
} from "@/features/workspace/model";
import {
  MODE_META,
  startsFromArtefact,
  targetsTerraform,
  type WorkspaceMode,
} from "@/features/workspace/modes";
import { parseMermaid } from "@/features/workspace/interchange";
import { parseTerraform } from "@/features/workspace/parse";
import type { BundleEntry, EvidenceReceipt } from "@/features/workspace/receipt";
import { DEFAULT_SETTINGS, type WorkspaceSettings } from "@/features/workspace/settings";
import { templateById, templateModel } from "@/features/workspace/templates";
import { emitTerraform, type TerraformTool } from "@/features/workspace/terraform";
import { downloadBlob, makeZip } from "@/utils/zip";
import { CanvasHeader } from "./canvas-header";
import { CodePane } from "./code-pane";
import { ComposePane } from "./compose-pane";
import { modelToSvg } from "./diagram-svg";
import { ErrorDialog } from "./error-dialog";
import { EvidencePane } from "./evidence-pane";
import { GeneratingScreen, GenerationTimeout } from "./generating";
import { HistoryMenu } from "./history-menu";
import { NodeInspector } from "./node-inspector";
import { OpenChangeDialog } from "./open-change-dialog";
import { Palette } from "./palette";
import { ACCEPTED_IMAGE_TYPES, ParsePane } from "./parse-pane";
import { ReviewPane } from "./review-pane";
import { ShareMenu } from "./share-menu";
import { WorkspaceTopbar } from "./topbar";
import type { ChatMessage, DemoState, WorkspaceStep } from "./types";

// The canvas is client-only (React Flow reads window/ResizeObserver), so it's
// loaded with SSR disabled and a warm placeholder while it hydrates.
const Canvas = dynamic(() => import("./canvas").then((m) => m.Canvas), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <p className="font-mono text-xs text-ink-faint">Loading canvas…</p>
    </div>
  ),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type PriorReceipt = { id: string; contentHash: string; signed: boolean; approvedAt: string };

export function Workspace({
  initialMode,
  user,
  workspaceId,
  initialModel,
  initialTranscript,
  initialCloud,
  initialTool,
  settings: initialSettings,
}: {
  initialMode: WorkspaceMode;
  user: { name: string; initials: string };
  workspaceId?: string;
  initialModel?: InfraModel;
  initialTranscript?: Array<{ role: "user" | "assistant"; text: string }>;
  initialCloud?: "azure" | "aws";
  initialTool?: TerraformTool;
  settings?: WorkspaceSettings;
}) {
  const settings = initialSettings ?? DEFAULT_SETTINGS;

  const [mode, setMode] = useState<WorkspaceMode>(initialMode);
  const [step, setStep] = useState<WorkspaceStep>("input");
  const [model, setModel] = useState<InfraModel>(initialModel ?? EMPTY_MODEL);
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    (initialTranscript ?? []).map((turn, index) => ({
      id: `t${index}`,
      role: turn.role,
      text: turn.text,
    })),
  );
  const [cloud, setCloud] = useState<"azure" | "aws">(initialCloud ?? settings.defaultCloud);
  const [tool, setTool] = useState<TerraformTool>(initialTool ?? settings.defaultTool);
  const [hidden, setHidden] = useState<Set<NodeCategory>>(new Set());
  const [activeFile, setActiveFile] = useState("main.tf");
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [engine, setEngine] = useState<EngineKind>("deterministic");
  /** The managed model the last managed turn ran on, so the receipt records what
   *  produced the plan rather than what settings say today. */
  const [inferenceModel, setInferenceModel] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<EvidenceReceipt | null>(null);
  const [bundle, setBundle] = useState<BundleEntry[]>([]);
  const [storedReceipt, setStoredReceipt] = useState(false);
  const [priorReceipts, setPriorReceipts] = useState<PriorReceipt[]>([]);
  const [genFailed, setGenFailed] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const idRef = useRef(0);

  const nextId = () => `m${idRef.current++}`;

  // The transcript persists with the snapshot, so reloading a workspace restores the
  // conversation that produced the model rather than an unexplained diagram.
  const transcriptOf = useCallback(
    (list: ChatMessage[]) => list.map((m) => ({ role: m.role, text: m.text })),
    [],
  );

  const persist = useCallback(
    (next: InfraModel, transcript: ChatMessage[]) => {
      if (!workspaceId) return;
      void saveWorkspaceAction(workspaceId, next, transcriptOf(transcript)).catch(() => {});
    },
    [workspaceId, transcriptOf],
  );

  const updateModel = useCallback(
    (next: InfraModel) => {
      setModel(next);
      setMessages((current) => {
        persist(next, current);
        return current;
      });
    },
    [persist],
  );

  const terraform = useMemo(() => emitTerraform(model, cloud, tool), [model, cloud, tool]);
  const evidence = useMemo(
    () => buildEvidence(model, cloud, terraform, engine),
    [model, cloud, terraform, engine],
  );
  const explanation = useMemo(
    () => explainModel(model, cloud, terraform.regionLabel),
    [model, cloud, terraform.regionLabel],
  );
  const inferenceMode = inferenceModeLabel(engine);
  const targetsTf = targetsTerraform(mode);
  const selectedNode = selectedNodeId
    ? (model.nodes.find((n) => n.id === selectedNodeId) ?? null)
    : null;

  // Close the inspector when its node disappears (mode switch, parse, delete).
  useEffect(() => {
    if (selectedNodeId && !model.nodes.some((n) => n.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [model, selectedNodeId]);

  // Prior approvals for this workspace, so the audit trail is visible, not implied.
  useEffect(() => {
    if (!workspaceId) return;
    void listReceiptsAction(workspaceId)
      .then((rows) =>
        setPriorReceipts(
          rows.map((r) => ({
            id: r.id,
            contentHash: r.contentHash,
            signed: r.signed,
            approvedAt: r.approvedAt,
          })),
        ),
      )
      .catch(() => {});
  }, [workspaceId]);

  async function handleSend(text: string) {
    if (busy) return;
    const withUser: ChatMessage[] = [...messages, { id: nextId(), role: "user", text }];
    setMessages(withUser);
    setStep("input");
    setBusy(true);

    // Chat → Model runs server-side (managed UK inference when configured). If the
    // request can't be reached — signed out, offline, gateway down — fall back to the
    // deterministic engine so the workspace never dead-ends.
    let result: ComposeResult;
    try {
      const res = await fetch("/api/workspace/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: text, model }),
      });
      if (!res.ok) throw new Error(`translate ${res.status}`);
      result = (await res.json()) as ComposeResult;
    } catch {
      result = composeFromPrompt(text, model);
    }

    setEngine(result.engine ?? "deterministic");
    setInferenceModel(result.inferenceModel ?? null);
    setModel(result.model);
    // "deploy a lambda to AWS" names its cloud; the toggle follows the brief.
    if (result.cloud && result.cloud !== cloud) handleCloudChange(result.cloud);
    const withReply: ChatMessage[] = [
      ...withUser,
      { id: nextId(), role: "assistant", text: result.reply, flags: countFlags(result.model) },
    ];
    setMessages(withReply);
    persist(result.model, withReply);
    setBusy(false);
  }

  function handleModeChange(next: WorkspaceMode) {
    setMode(next);
    setStep("input");
    setSelectedNodeId(null);
    if (workspaceId) void updateWorkspaceAction(workspaceId, { mode: next }).catch(() => {});
  }

  function handleCloudChange(next: "azure" | "aws") {
    setCloud(next);
    if (workspaceId) void updateWorkspaceAction(workspaceId, { cloud: next }).catch(() => {});
  }

  function handleToolChange(next: TerraformTool) {
    setTool(next);
    if (workspaceId) void updateWorkspaceAction(workspaceId, { tool: next }).catch(() => {});
  }

  function toggleCategory(c: NodeCategory) {
    setHidden((prev) => {
      const set = new Set(prev);
      if (set.has(c)) set.delete(c);
      else set.add(c);
      return set;
    });
  }

  function handleParse(source: string) {
    // Which reader runs is the mode's decision, not a guess from the text: a
    // Terraform file pasted into the diagram pane gets the diagram reader's error,
    // which names the format it expected.
    const res = MODE_META[mode].from === "diagram" ? parseMermaid(source) : parseTerraform(source);
    if (!res.ok) {
      setError({ title: "Couldn’t read that file", message: res.error });
      return;
    }
    // A parsed diagram came from a file, not inference — reflect that honestly.
    setEngine("deterministic");
    // Terraform names its provider; a flowchart does not, so the target cloud stays.
    if ("cloud" in res) setCloud(res.cloud as Cloud);
    updateModel(res.model);
    setStep("input");
    const targetCloud = "cloud" in res ? (res.cloud as Cloud) : cloud;
    const feasibility = assessFeasibility(res.model, targetCloud);
    toast.success("Diagram reconstructed", { description: feasibility.summary });
    announce(feasibility.summary, res.model);
  }

  /** Put an importer's verdict in the conversation, where the reply to a prompt goes. */
  function announce(text: string, next: InfraModel) {
    setMessages((prev) => [...prev, { id: nextId(), role: "assistant", text, flags: countFlags(next) }]);
  }

  /**
   * A picture of a diagram, read server-side by managed inference. There is no
   * deterministic fallback for a picture, so a refusal is shown as the reason it
   * was refused rather than swapped for a sample.
   */
  async function handleImage(file: File) {
    // A dropped file never passed through the dialog's `accept` filter, so the
    // format is checked here rather than letting the route answer with a generic 400.
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setError({
        title: "That file isn’t a picture",
        message: "Upload a PNG, JPEG, WebP or GIF — a screenshot or a photo of the diagram.",
      });
      return;
    }
    if (file.size > 4_500_000) {
      setError({ title: "That image is too large", message: "Keep it under 4.5 MB, or crop to the diagram." });
      return;
    }
    setImageBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const res = await fetch("/api/workspace/read-diagram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mediaType: file.type, data }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        model?: InfraModel;
        untranslated?: string[];
        reply?: string;
        cloud?: Cloud | null;
      };
      if (!res.ok || !payload.model) {
        setError({ title: "Couldn’t read that picture", message: payload.error ?? `The server answered ${res.status}.` });
        return;
      }
      setEngine("managed");
      updateModel(payload.model);
      setStep("input");
      // A page of AWS icons is an AWS design, whatever the toggle said.
      const targetCloud = payload.cloud ?? cloud;
      if (payload.cloud && payload.cloud !== cloud) handleCloudChange(payload.cloud);
      const feasibility = assessFeasibility(payload.model, targetCloud);
      toast.success("Diagram read from the picture", { description: feasibility.summary });
      announce([payload.reply, feasibility.summary].filter(Boolean).join(" "), payload.model);
    } catch (err) {
      setError({ title: "Couldn’t read that picture", message: err instanceof Error ? err.message : "Unknown error." });
    } finally {
      setImageBusy(false);
    }
  }

  /* ----------------------------------------------------------- canvas edits -- */

  function handleAddKind(kind: string, position?: { x: number; y: number }) {
    const result = addNode(model, kind, position);
    if (!result) return;
    updateModel(result.model);
    setSelectedNodeId(result.id);
    toast.success(`${kindDefinition(kind)?.label ?? kind} added`, {
      description: "Connections you draw from here are kept as yours.",
    });
  }

  function handleStartTemplate(templateId: string) {
    const template = templateById(templateId);
    if (!template) return;
    updateModel(templateModel(template));
    setStep("input");
    toast.success(`Started from ${template.name}`, {
      description: "Edit it on the canvas — add, connect and remove components.",
    });
  }

  function handleConnect(source: string, target: string) {
    updateModel(connectNodes(model, source, target));
  }

  function handleDeleteNodes(ids: string[]) {
    updateModel(removeNodes(model, ids));
    toast.success(ids.length === 1 ? "Component removed" : `${ids.length} components removed`);
  }

  function handleDeleteEdges(ids: string[]) {
    updateModel(removeEdges(model, ids));
  }

  function handleNodeMoved(id: string, position: { x: number; y: number }) {
    updateModel(setNodePosition(model, id, position));
  }

  /* ------------------------------------------------------------- generation -- */

  function exportDiagram() {
    const svg = modelToSvg(model, hidden);
    if (!svg) {
      toast.error("Nothing to export yet", { description: "Add resources to the model first." });
      return;
    }
    downloadBlob(new Blob([svg], { type: "image/svg+xml" }), "architecture.svg");
    toast.success("Diagram exported", { description: "architecture.svg saved to your downloads." });
  }

  function handleCanvasAction() {
    if (targetsTf) setStep("review");
    else exportDiagram();
  }

  async function handleGenerate() {
    setGenFailed(false);
    setReceipt(null);
    setBundle([]);
    setActiveFile("main.tf");
    setStep("generating");
    const [result] = await Promise.all([
      generateEvidenceAction({
        model,
        cloud,
        engine,
        tool,
        ...(inferenceModel ? { inferenceModel } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      }),
      sleep(
        typeof window !== "undefined" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 1100,
      ),
    ]);
    setReceipt(result?.receipt ?? null);
    setBundle(result?.bundle ?? []);
    setStoredReceipt(result?.stored ?? false);
    setStep("result");
    if (result?.stored && workspaceId) {
      void listReceiptsAction(workspaceId)
        .then((rows) =>
          setPriorReceipts(
            rows.map((r) => ({
              id: r.id,
              contentHash: r.contentHash,
              signed: r.signed,
              approvedAt: r.approvedAt,
            })),
          ),
        )
        .catch(() => {});
    }
    toast.success("Evidence bundle generated", {
      description: result?.receipt?.signed
        ? "Signed SBOM + plan (Ed25519)."
        : "SBOM + plan · content-hashed (set EVIDENCE_SIGNING_KEY to sign).",
    });
  }

  function handleDownload() {
    downloadBlob(makeZip(terraform.files), `terragram-${tool}.zip`);
    toast.success("Terraform downloaded", { description: `terragram-${tool}.zip` });
  }

  function handleDownloadBundle() {
    if (bundle.length === 0) {
      toast.error("No bundle yet", { description: "Confirm the review gate first." });
      return;
    }
    downloadBlob(makeZip(bundle), "terragram-evidence.zip");
    toast.success("Evidence bundle downloaded", {
      description: "Check it offline at /verify — it carries its own public key.",
    });
  }

  async function handleCopyPlan() {
    const plan = terraform.files.map((f) => `# ${f.name}\n${f.content}`).join("\n\n");
    try {
      await navigator.clipboard.writeText(plan);
      toast.success("Plan copied to clipboard");
    } catch {
      toast.error("Couldn’t copy — your browser blocked clipboard access.");
    }
  }

  function handleSignOut() {
    void signOut().then((res) => {
      if (!res.ok) {
        toast.error("Could not sign you out. Please try again.");
        return;
      }
      window.location.assign("/login");
    });
  }

  function handleRestore(restored: {
    model: InfraModel;
    transcript: Array<{ role: "user" | "assistant"; text: string }>;
  }) {
    // Restoring is non-destructive: the restored model is saved forward as a new
    // head, so the history it was taken from is still there afterwards.
    setModel(restored.model);
    const messagesFromHistory: ChatMessage[] = restored.transcript.map((turn, index) => ({
      id: `r${Date.now()}-${index}`,
      role: turn.role,
      text: turn.text,
    }));
    setMessages(messagesFromHistory);
    persist(restored.model, messagesFromHistory);
    setStep("input");
    toast.success("Snapshot restored", { description: "Saved forward — nothing was overwritten." });
  }

  function handleInspectorLabel(id: string, label: string) {
    updateModel(setNodeLabel(model, id, label));
  }
  function handleInspectorAttr(id: string, key: string, value: string) {
    updateModel(setNodeAttribute(model, id, key, value));
  }
  function handleInspectorResolve(id: string) {
    updateModel(resolveNodeFlag(model, id));
    toast.success("Node resolved", { description: "The review flag was cleared." });
  }

  function handleDemoState(kind: DemoState) {
    if (kind === "ambiguous") {
      if (MODE_META[mode].from === "chat") {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            text: settings.askAmbiguous
              ? "That could mean a few things — where should the cache sit? Pick one and I’ll refine the model."
              : "That was ambiguous. I picked the safer default and flagged the node for review.",
            ...(settings.askAmbiguous
              ? { options: ["In front of the database", "Beside the web tier"] }
              : {}),
          },
        ]);
      }
      toast.warning("Model needs clarification", {
        description: settings.askAmbiguous
          ? "The prompt was ambiguous — Terragram asked a follow-up."
          : "The prompt was ambiguous — Terragram chose a default and flagged it.",
      });
    } else if (kind === "unparseable") {
      setError({
        title: "Couldn’t read that file",
        message:
          "None of the resources in that file are ones Terragram can map yet. It reads the AWS and Azure services in the component palette — compute, networking, storage, identity and monitoring.",
      });
    } else {
      setGenFailed(true);
      setStep("generating");
    }
  }

  const leftPane =
    step === "review" ? (
      <ReviewPane
        model={model}
        cloud={cloud}
        onCloudChange={handleCloudChange}
        regionLabel={terraform.regionLabel}
        explanation={explanation}
        feasibility={assessFeasibility(model, cloud)}
        onBack={() => setStep("input")}
        onGenerate={handleGenerate}
      />
    ) : startsFromArtefact(mode) ? (
      <ParsePane
        mode={mode}
        onModeChange={handleModeChange}
        from={MODE_META[mode].from as "terraform" | "diagram"}
        onParse={handleParse}
        onImage={handleImage}
        imageBusy={imageBusy}
        onStartTemplate={handleStartTemplate}
      />
    ) : (
      <ComposePane
        mode={mode}
        onModeChange={handleModeChange}
        messages={messages}
        onSend={handleSend}
        busy={busy}
        inferenceMode={inferenceMode}
        showSuggestions={settings.showSuggestions}
      />
    );

  const status =
    model.nodes.length > 0
      ? `${model.nodes.length} nodes · ${model.topology === "manual" ? "your layout" : "auto-routed"}`
      : "empty";

  return (
    <>
      <div className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center md:hidden">
        <LogoMark className="size-11 rounded-xl text-base" />
        <h1 className="text-lg font-bold text-foreground">The workspace needs a wider screen</h1>
        <p className="max-w-xs text-sm text-muted-foreground">
          The diagram canvas is built for a tablet or desktop. On mobile you can still read the
          docs and manage your account.
        </p>
        <Link
          href="/workspace"
          className="rounded-lg border border-line-strong bg-card px-4 py-2 text-sm font-semibold text-foreground"
        >
          Back to workspaces
        </Link>
      </div>

      <div className="hidden h-dvh flex-col overflow-hidden md:flex">
        <WorkspaceTopbar
          region={terraform.regionLabel}
          inferenceMode={inferenceMode}
          cloud={cloud}
          onCloudChange={handleCloudChange}
          tool={tool}
          onToolChange={handleToolChange}
          step={step}
          showSteps={targetsTf}
          user={user}
          onDemoState={handleDemoState}
          onSignOut={handleSignOut}
          extras={
            workspaceId ? (
              <>
                <HistoryMenu workspaceId={workspaceId} onRestore={handleRestore} />
                <ShareMenu workspaceId={workspaceId} />
              </>
            ) : null
          }
        />

        <main id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 outline-none">
          {step === "generating" ? (
            <div className="min-w-0 flex-1">
              {genFailed ? (
                <GenerationTimeout
                  cloud={cloud}
                  onBackToReview={() => {
                    setGenFailed(false);
                    setStep("review");
                  }}
                  onRetry={handleGenerate}
                />
              ) : (
                <GeneratingScreen cloud={cloud} provider={terraform.provider} />
              )}
            </div>
          ) : step === "result" ? (
            <>
              <div className="min-w-0 flex-1 border-r border-line-strong">
                <CodePane
                  files={terraform.files}
                  activeFile={activeFile}
                  onSelectFile={setActiveFile}
                  provider={terraform.provider}
                  explanation={receipt?.explanation ?? explanation}
                />
              </div>
              <aside className="w-[360px] shrink-0">
                <EvidencePane
                  model={model}
                  summary={evidence}
                  receipt={receipt}
                  stored={storedReceipt}
                  priorReceipts={priorReceipts}
                  onDownload={handleDownload}
                  onDownloadBundle={handleDownloadBundle}
                  onExportDiagram={exportDiagram}
                  onCopyPlan={handleCopyPlan}
                  openChange={
                    <OpenChangeDialog
                      model={model}
                      cloud={cloud}
                      engine={engine}
                      tool={tool}
                      disabled={!receipt}
                    />
                  }
                />
              </aside>
            </>
          ) : (
            <>
              <aside className="w-[380px] shrink-0 border-r border-line-strong">{leftPane}</aside>
              <div className="flex min-w-0 flex-1 flex-col">
                <CanvasHeader
                  mode={mode}
                  onModeChange={handleModeChange}
                  status={status}
                  hidden={hidden}
                  onToggleCategory={toggleCategory}
                  actionLabel={targetsTf ? "Generate code" : "Export diagram"}
                  onAction={handleCanvasAction}
                  actionDisabled={model.nodes.length === 0 || step === "review"}
                  paletteOpen={showPalette}
                  onTogglePalette={() => setShowPalette((v) => !v)}
                />
                <div className="flex min-h-0 flex-1">
                  <div className="relative min-h-0 flex-1 bg-background">
                    <Canvas
                      model={model}
                      hiddenCategories={hidden}
                      settings={settings}
                      onNodeClick={(id) => setSelectedNodeId(id)}
                      onNodeMoved={handleNodeMoved}
                      onConnect={handleConnect}
                      onDeleteNodes={handleDeleteNodes}
                      onDeleteEdges={handleDeleteEdges}
                      onDropKind={(kind, position) => handleAddKind(kind, position)}
                    />
                  </div>
                  {selectedNode && (
                    <aside className="w-[300px] shrink-0">
                      <NodeInspector
                        node={selectedNode}
                        onClose={() => setSelectedNodeId(null)}
                        onLabelChange={handleInspectorLabel}
                        onAttributeChange={handleInspectorAttr}
                        onResolve={handleInspectorResolve}
                        onDelete={(id) => handleDeleteNodes([id])}
                      />
                    </aside>
                  )}
                  {showPalette && (
                    <aside className="w-[240px] shrink-0">
                      <Palette onAdd={(kind) => handleAddKind(kind)} />
                    </aside>
                  )}
                </div>
              </div>
            </>
          )}
        </main>

        <ErrorDialog
          open={error !== null}
          onOpenChange={(open) => !open && setError(null)}
          title={error?.title ?? ""}
          message={error?.message ?? ""}
        />
      </div>
    </>
  );
}
