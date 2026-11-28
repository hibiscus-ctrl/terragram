// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Draw an existing estate from infraharvest's `graph/v1` document, as an SVG, a draw.io file or a Mermaid
 * flowchart, optionally against an earlier graph and with findings laid over it. Pure and
 * deterministic: the same document gives the same bytes, in whatever order it lists its
 * nodes. `layoutGraphDocument` / `layoutGraphView` return the picture as plain data
 * (`diagram.graph-layout/v2`: rectangles, routes, badges) for a viewer that draws it itself;
 * the SVG is drawn from it. `level` (overview, services, detailed) and `focus` choose how much is drawn; `icon` lets a caller that
 * has the clouds' icons put them on the cards (the engine ships none). `serviceOf` maps a Terraform type to a service id.
 * See AGENTS.md's "Graph rendering".
 */

export { type GraphDiff, diffGraphs } from "./graph/diff.ts";
export {
  type GraphFinding,
  type Severity,
  findingsFromOcsf,
  findingsFromReview,
  parseFindings,
  SEVERITIES,
} from "./graph/findings.ts";
export { DEFAULT_GLUE, type GlueRule } from "./graph/glue.ts";
export { CATEGORY_GLYPHS } from "./graph/glyphs.ts";
export type { IconQuery, IconRef, IconResolver } from "./graph/icons.ts";
export { DEFAULT_ASPECT, type LayoutOptions as GraphLayoutOptions, MAX_ASPECT, MIN_ASPECT } from "./graph/layout.ts";
export { renderGraphDrawio } from "./graph/drawio.ts";
export { drawioIconStyle } from "./graph/drawio-shapes.ts";
export { GraphViewError } from "./graph/levels.ts";
export {
  GRAPH_LAYOUT_SCHEMA,
  type GraphLayoutView,
  graphLayoutSchema,
  type LayoutEdge,
  type LayoutGroup,
  type LayoutNode,
  layoutGraphDocument,
  layoutGraphView,
  type LayoutViewOptions,
} from "./graph/layout-view.ts";
export { renderGraphMermaid } from "./graph/mermaid.ts";
export { MAX_GRAPH_NODES, type ProjectOptions, projectGraph } from "./graph/project.ts";
export { type GraphDocument, GraphDocumentError, graphDocumentSchema, parseGraphDocument } from "./graph/schema.ts";
export {
  categoryOfType,
  GRAPH_CATEGORIES,
  listServices,
  providerOfType,
  type ServiceInfo,
  serviceById,
  serviceLabel,
  serviceOf,
} from "./graph/services.ts";
export { renderGraphSvg } from "./graph/svg.ts";
export {
  type FocusOptions,
  GRAPH_LEVELS,
  type GraphCategory,
  type GraphLevel,
  type GraphView,
  MAX_FOCUS_HOPS,
  type ViewAggregate,
  type ViewEdge,
  type ViewGroup,
  type ViewNode,
} from "./graph/view.ts";
