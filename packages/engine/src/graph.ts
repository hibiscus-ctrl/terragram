// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Draw an existing estate from infraharvest's `graph/v1` document, as an SVG, a draw.io file or a Mermaid
 * flowchart, optionally against an earlier graph and with findings laid over it. Pure and
 * deterministic: the same document gives the same bytes, in whatever order it lists its
 * nodes. `layoutGraphDocument` / `layoutGraphView` return the picture as plain data
 * (`diagram.graph-layout/v1`: rectangles, routes, badges) for a viewer that draws it itself;
 * the SVG is drawn from it. See AGENTS.md's "Graph rendering".
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
export { renderGraphDrawio } from "./graph/drawio.ts";
export {
  GRAPH_LAYOUT_SCHEMA,
  type GraphLayoutView,
  graphLayoutSchema,
  type LayoutEdge,
  type LayoutGroup,
  type LayoutNode,
  layoutGraphDocument,
  layoutGraphView,
} from "./graph/layout-view.ts";
export { renderGraphMermaid } from "./graph/mermaid.ts";
export {
  type GraphView,
  MAX_GRAPH_NODES,
  type ProjectOptions,
  projectGraph,
  type ViewEdge,
  type ViewGroup,
  type ViewNode,
} from "./graph/project.ts";
export { type GraphDocument, GraphDocumentError, graphDocumentSchema, parseGraphDocument } from "./graph/schema.ts";
export { renderGraphSvg } from "./graph/svg.ts";
