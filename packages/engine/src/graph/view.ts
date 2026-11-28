// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { FindingTally, Severity } from "./findings.ts";
import type { GraphDocument } from "./schema.ts";
import type { GraphCategory } from "./services.ts";

/** The shape of a picture before it is drawn (see project.ts, which builds it). Types only, so the code that reshapes a view can import them without importing the code that builds one. */

export type { GraphCategory };

export type GraphStatus = "unchanged" | "added" | "removed" | "changed" | "context";
/** An edge that stands for several references says `changed` when they did not all change the same way. */
export type EdgeStatus = "unchanged" | "added" | "removed" | "changed";

/** How much of the estate a picture draws: a box per group, a card per service in a group, or a card per resource. */
export const GRAPH_LEVELS = ["overview", "services", "detailed"] as const;
export type GraphLevel = (typeof GRAPH_LEVELS)[number];
/** The most hops a focus reaches. */
export const MAX_FOCUS_HOPS = 3;

export type FocusOptions = {
  /** A node's id as the picture of the same options has it, or a label (a resource's short ID) that only one node has. */
  node: string;
  /** How many references away from the node to go, from 1 to {@link MAX_FOCUS_HOPS}. Default 1. */
  hops?: number;
};

export type ViewGroup = {
  id: string;
  kind: "scope" | "environment" | "module";
  label: string;
  detail?: string;
  parent: string | null;
  status: GraphStatus;
  findings: FindingTally | null;
};

export type ViewNode = {
  id: string;
  group: string;
  /** The resource type, or `module call` for a module's card. For a card that stands for several resources, the type most of them have; `aggregate.types` has them all. */
  type: string;
  label: string;
  /** The cloud service of the type (`aws.rds`, `azure.sql`, `gcp.gke`; see `serviceOf`), `terraform.module` for a module's card, `terraform.group` for a group's summary card. */
  service: string;
  category: GraphCategory;
  region?: string;
  /** The environment of the node's root, when the graph names one. */
  environment?: string;
  status: GraphStatus;
  findings: FindingTally | null;
  /** Present on a card that stands for several resources: which, and how many. */
  aggregate?: ViewAggregate;
};

/** What a card of the Overview or Services level stands for, so that a viewer can expand it. */
export type ViewAggregate = {
  level: "overview" | "services";
  /** How many nodes of the detailed picture it stands for. */
  count: number;
  /** Their ids in the detailed picture of the same document and options (`level: "detailed"`, no focus). */
  ids: string[];
  byCategory: Partial<Record<GraphCategory, number>>;
  byStatus: Partial<Record<GraphStatus, number>>;
  /** The resource types among them, the most numerous first. */
  types: { type: string; count: number }[];
  /** References between two of them: not drawn, since both ends are this card. */
  internal: number;
};

export type ViewEdge = {
  from: string;
  to: string;
  status: EdgeStatus;
  /** How many references of the detailed picture the line stands for: 1 unless its ends are cards of the Overview or Services level. */
  count: number;
};

export type GraphView = {
  schema: "diagram.graph-view/v2";
  cloud: GraphDocument["cloud"];
  title?: string;
  mode: "full" | "delta";
  level: GraphLevel;
  /** Present when the picture was cut to a node and its neighbours: which, how far, and how many cards of the picture it kept. */
  focus?: { node: string; label: string; hops: number; shown: number; of: number };
  /** A base graph was given, so statuses say what changed. */
  compared: boolean;
  groups: ViewGroup[];
  nodes: ViewNode[];
  edges: ViewEdge[];
  hidden: { count: number; types: { type: string; count: number }[] };
  /** Counts of what changed between base and head, with glue left out. */
  changes?: { nodesAdded: number; nodesRemoved: number; nodesChanged: number; edgesAdded: number; edgesRemoved: number };
  /** Present when the picture was cut to its first `maxNodes` cards: how many cards and references were left out. */
  cut?: { maxNodes: number; nodes: number; edges: number };
  /** How many findings were given, how many found nothing to attach to, and how many of each severity were placed. */
  findings?: { total: number; unplaced: number; bySeverity: Partial<Record<Severity, number>> };
};
