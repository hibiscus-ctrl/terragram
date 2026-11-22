"use client";

import { useCallback, useEffect } from "react";
import {
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";

import type { InfraModel, NodeCategory } from "@/features/workspace/model";
import type { WorkspaceSettings } from "@/features/workspace/settings";
import "@xyflow/react/dist/style.css";

import { nodeTypes } from "./category-node";
import { type CategoryNodeData, layoutModel, miniMapColor } from "./graph";

type CanvasProps = {
  model: InfraModel;
  hiddenCategories: Set<NodeCategory>;
  settings: WorkspaceSettings;
  onNodeClick?: (id: string) => void;
  /** A node was dragged — remember where, so the layout survives the next turn. */
  onNodeMoved?: (id: string, position: { x: number; y: number }) => void;
  onConnect?: (source: string, target: string) => void;
  onDeleteNodes?: (ids: string[]) => void;
  onDeleteEdges?: (ids: string[]) => void;
  /** A kind dropped from the palette, with the canvas coordinates it landed at. */
  onDropKind?: (kind: string, position: { x: number; y: number }) => void;
  readOnly?: boolean;
};

function CanvasInner({
  model,
  hiddenCategories,
  settings,
  onNodeClick,
  onNodeMoved,
  onConnect,
  onDeleteNodes,
  onDeleteEdges,
  onDropKind,
  readOnly = false,
}: CanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CategoryNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView, screenToFlowPosition } = useReactFlow();

  // Re-layout whenever the model or legend visibility changes, then refit so the
  // whole graph stays framed as it grows. The JS-driven refit respects
  // prefers-reduced-motion (the CSS media query cannot reach React Flow's animation)
  // and is skipped entirely when the reviewer has turned auto-layout off.
  useEffect(() => {
    const laid = layoutModel(model, hiddenCategories, {
      edgeRouting: settings.edgeRouting,
      labelFace: settings.labelFace,
      autoLayout: settings.autoLayout,
    });
    setNodes(laid.nodes);
    setEdges(laid.edges);
    if (laid.nodes.length > 0 && settings.autoLayout) {
      const reduced =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const raf = requestAnimationFrame(() =>
        fitView({ padding: 0.2, duration: reduced ? 0 : 300, maxZoom: 1.2 }),
      );
      return () => cancelAnimationFrame(raf);
    }
    return undefined;
  }, [model, hiddenCategories, settings, fitView, setNodes, setEdges]);

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) onConnect?.(connection.source, connection.target);
    },
    [onConnect],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData("application/terragram-kind");
      if (!kind) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      onDropKind?.(kind, position);
    },
    [onDropKind, screenToFlowPosition],
  );

  if (model.nodes.length === 0) {
    // A drop target has no semantic element of its own, so it is a labelled group.
    // The palette's buttons are the keyboard route to the same action, which is why
    // nothing here is reachable only by pointer.
    return (
      <section
        aria-label="Diagram canvas"
        className="flex h-full items-center justify-center"
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <svg viewBox="0 0 24 24" className="size-8 text-ink-faint" fill="none" aria-hidden>
            <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          <p className="font-mono text-sm text-muted-foreground">
            {readOnly
              ? "This workspace has no components yet"
              : "Describe your architecture, or add a component from the palette"}
          </p>
        </div>
      </section>
    );
  }

  return (
    <ReactFlow
      // The wrapper is `role="application"`; without a name a screen reader
      // announces an unnamed application. Same name as the empty state's group.
      aria-label="Diagram canvas"
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      {...(onNodeClick
        ? { onNodeClick: (_: unknown, node: Node<CategoryNodeData>) => onNodeClick(node.id) }
        : {})}
      {...(readOnly
        ? {}
        : {
            onConnect: handleConnect,
            onNodeDragStop: (_: unknown, node: Node<CategoryNodeData>) =>
              onNodeMoved?.(node.id, node.position),
            onNodesDelete: (deleted: Node<CategoryNodeData>[]) =>
              onDeleteNodes?.(deleted.map((n) => n.id)),
            onEdgesDelete: (deleted: Edge[]) => onDeleteEdges?.(deleted.map((e) => e.id)),
            onDrop: handleDrop,
            onDragOver: (e: React.DragEvent) => e.preventDefault(),
          })}
      nodeTypes={nodeTypes}
      colorMode="light"
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
      proOptions={{ hideAttribution: true }}
      minZoom={0.3}
      maxZoom={2}
      nodesConnectable={!readOnly}
      nodesDraggable={!readOnly}
      elementsSelectable
      deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
      edgesFocusable={!readOnly}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#e6e0d3" />
      <Controls showInteractive={false} className="!shadow-sm" />
      <MiniMap
        nodeColor={miniMapColor}
        nodeStrokeWidth={2}
        pannable
        zoomable
        className="!rounded-lg !border !border-line-strong"
      />
    </ReactFlow>
  );
}

export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

export default Canvas;
