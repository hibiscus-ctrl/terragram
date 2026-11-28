// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import dagre from "dagre";

import { NODE_HEIGHT } from "../layout.ts";
import type { GraphView } from "./project.ts";

/**
 * Where everything of a {@link GraphView} sits. The picture is built from the inside out. The resources of a box
 * that refer to each other are laid out by dagre as a layered graph (a *cluster*, with the lines between them routed
 * around its cards); a resource that refers to none of its box's is a block of one card. A box's blocks (its
 * clusters, its lone cards and its inner boxes) are then packed onto rows toward {@link DEFAULT_ASPECT} (or the
 * `aspect` asked for), so a picture of many boxes comes out as wide as it is tall, not as a strip of boxes side by
 * side. Each box is drawn around what it holds with room for its label, and a line that crosses from one block to
 * another is routed here, in the gaps between them where there is a gap to use.
 *
 * Every order is the view's (its places: scope, environment, module path, address, key) or a sort with that order as
 * the tie-break, so the same view gives the same layout, and every number is rounded so that no float arithmetic
 * reaches the output.
 */

export type Box = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

export type GraphLayout = {
  width: number;
  height: number;
  /** By node id. */
  nodes: Map<string, Box>;
  /** By group id. */
  groups: Map<string, Box>;
  /** In the order of the view's edges. */
  edges: Point[][];
};

export type LayoutOptions = {
  /** The width over the height to pack toward. Default {@link DEFAULT_ASPECT}; must be from {@link MIN_ASPECT} to {@link MAX_ASPECT}. */
  aspect?: number;
};

/** About a 16:10 screen: the shape the picture is packed toward when no `aspect` is given. */
export const DEFAULT_ASPECT = 1.6;
export const MIN_ASPECT = 0.5;
export const MAX_ASPECT = 4;

/** The width and height of a resource's card: room for 36 characters of its type and 24 of its name. */
const CARD_WIDTH = 224;
const CARD_HEIGHT = NODE_HEIGHT;

const MARGIN = 24;
/** Room above the first thing in a box, for its label. */
export const HEADER = 22;
const PAD = 14;
const NODE_GAP = 40;
const RANK_GAP = 72;
/** Between two blocks of a box, in a row and between rows: room for a line to run in. */
const BLOCK_GAP = 36;
/** What the shape asked of the boxes inside is, over the shape asked of the picture, tried in this order. */
const INNER_SHAPES = [1, 0.7, 0.5, 1.4, 0.35, 2];
/** How far along a card's edge a line may be moved from its middle to find a way through. */
const SHIFTS = [0, 60, -60, 90, -90];
/** How near a line may pass a card it is not drawn to. */
const CLEARANCE = 6;

const round = (n: number) => Math.round(n);

/** `aspect`, or the default; a number outside the bounds is a mistake of the caller's, not something to quietly change. */
function checkAspect(aspect: number | undefined): number {
  if (aspect === undefined) return DEFAULT_ASPECT;
  if (typeof aspect !== "number" || !Number.isFinite(aspect) || aspect < MIN_ASPECT || aspect > MAX_ASPECT) {
    throw new RangeError(`aspect must be a number from ${MIN_ASPECT} to ${MAX_ASPECT}`);
  }
  return aspect;
}

/** What is laid out inside a block, in coordinates from the block's own top-left corner. */
type Placed = {
  nodes: Map<string, Box>;
  groups: Map<string, Box>;
  /** By the index of the view's edge. */
  edges: Map<number, Point[]>;
};
type Block = Placed & { width: number; height: number };

const emptyPlaced = (): Placed => ({ nodes: new Map(), groups: new Map(), edges: new Map() });

/** Adds what `from` holds to `into`, moved by (dx, dy). */
function absorb(into: Placed, from: Placed, dx: number, dy: number): void {
  const move = (b: Box): Box => ({ ...b, x: b.x + dx, y: b.y + dy });
  for (const [id, b] of from.nodes) into.nodes.set(id, move(b));
  for (const [id, b] of from.groups) into.groups.set(id, move(b));
  for (const [i, line] of from.edges) into.edges.set(i, line.map((p) => ({ x: p.x + dx, y: p.y + dy })));
}

/** One card on its own. */
function cardBlock(id: string): Block {
  const block: Block = { ...emptyPlaced(), width: CARD_WIDTH, height: CARD_HEIGHT };
  block.nodes.set(id, { x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT });
  return block;
}

/** Cards that refer to each other, as dagre lays them out in layers, moved so that the top-left of what is drawn is the origin. */
function clusterBlock(ids: readonly string[], edges: readonly { index: number; from: string; to: string }[]): Block {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: NODE_GAP, ranksep: RANK_GAP, edgesep: 20, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of ids) g.setNode(id, { width: CARD_WIDTH, height: CARD_HEIGHT });
  for (const edge of edges) g.setEdge(edge.from, edge.to);
  dagre.layout(g);

  const lines = edges.map((edge) => ({ index: edge.index, points: (g.edge(edge.from, edge.to)?.points ?? []).map((p) => ({ x: p.x, y: p.y })) }));
  const centres = ids.map((id) => g.node(id));
  const points = lines.flatMap((l) => l.points);
  const minX = Math.min(...centres.map((c) => c.x - CARD_WIDTH / 2), ...points.map((p) => p.x));
  const minY = Math.min(...centres.map((c) => c.y - CARD_HEIGHT / 2), ...points.map((p) => p.y));
  const maxX = Math.max(...centres.map((c) => c.x + CARD_WIDTH / 2), ...points.map((p) => p.x));
  const maxY = Math.max(...centres.map((c) => c.y + CARD_HEIGHT / 2), ...points.map((p) => p.y));

  const block: Block = { ...emptyPlaced(), width: round(maxX - minX), height: round(maxY - minY) };
  ids.forEach((id, i) => {
    const c = centres[i] as { x: number; y: number };
    block.nodes.set(id, { x: round(c.x - CARD_WIDTH / 2 - minX), y: round(c.y - CARD_HEIGHT / 2 - minY), width: CARD_WIDTH, height: CARD_HEIGHT });
  });
  for (const line of lines) block.edges.set(line.index, line.points.map((p) => ({ x: p.x - minX, y: p.y - minY })));
  return block;
}

/** Fills rows left to right, starting a new one where the next block would pass `limit`. */
function shelves(blocks: readonly Block[], limit: number): { at: Point[]; width: number; height: number } {
  const at: Point[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const block of blocks) {
    if (x > 0 && x + block.width > limit) {
      y += rowHeight + BLOCK_GAP;
      x = 0;
      rowHeight = 0;
    }
    at.push({ x, y });
    x += block.width + BLOCK_GAP;
    rowHeight = Math.max(rowHeight, block.height);
    width = Math.max(width, x - BLOCK_GAP);
  }
  return { at, width, height: y + rowHeight };
}

/**
 * The blocks on rows, tallest first (then in the view's order), with the row length that comes nearest to `aspect`:
 * each place a row could end is tried, and a shape that leaves much empty is worth less than one that does not.
 */
function pack(blocks: readonly Block[], aspect: number): { block: Block; cost: number } {
  const order = blocks.map((block, i) => ({ block, i })).sort((a, b) => b.block.height - a.block.height || a.i - b.i);
  const sorted = order.map((o) => o.block);
  const used = sorted.reduce((sum, b) => sum + b.width * b.height, 0);
  const widest = Math.max(0, ...sorted.map((b) => b.width));

  const limits = new Set<number>([widest]);
  let run = -BLOCK_GAP;
  for (const block of sorted) {
    run += BLOCK_GAP + block.width;
    if (run >= widest) limits.add(run);
  }
  let best: { at: Point[]; width: number; height: number } | undefined;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const limit of [...limits].sort((a, b) => a - b)) {
    const shape = shelves(sorted, limit);
    const cost = Math.abs(Math.log(shape.width / shape.height / aspect)) + 0.25 * Math.log((shape.width * shape.height) / used);
    if (cost < bestCost - 1e-9) {
      best = shape;
      bestCost = cost;
    }
  }
  const shape = best ?? { at: [], width: 0, height: 0 };

  const packed: Block = { ...emptyPlaced(), width: shape.width, height: shape.height };
  sorted.forEach((block, i) => {
    const at = shape.at[i] as Point;
    absorb(packed, block, at.x, at.y);
  });
  return { block: packed, cost: bestCost };
}

/**
 * A line from card `a` to card `b` that keeps clear of the other cards where it can. Cards on different rows are joined
 * from the near edge of one to the near edge of the other, with the bend as near the middle as a gap allows, then shifted
 * along the edges; cards on one row are joined sideways, or over or under the row. If every try runs over a card, the first is kept.
 */
function route(a: Box, b: Box, cards: readonly Box[]): Point[] {
  const [ax, bx] = [a.x + a.width / 2, b.x + b.width / 2];
  const [ay, by] = [a.y + a.height / 2, b.y + b.height / 2];
  const others = cards.filter((c) => c !== a && c !== b);
  const blocked = (line: Point[]): boolean =>
    line.some((p, i) => {
      const q = line[i + 1];
      if (q === undefined) return false;
      const [x0, x1] = [Math.min(p.x, q.x) - CLEARANCE, Math.max(p.x, q.x) + CLEARANCE];
      const [y0, y1] = [Math.min(p.y, q.y) - CLEARANCE, Math.max(p.y, q.y) + CLEARANCE];
      return others.some((c) => c.x < x1 && c.x + c.width > x0 && c.y < y1 && c.y + c.height > y0);
    });

  function* tries(): Generator<Point[]> {
    if (b.y >= a.y + a.height || b.y + b.height <= a.y) {
      const down = b.y >= a.y + a.height;
      const [from, to] = [down ? a.y + a.height : a.y, down ? b.y : b.y + b.height];
      const [lo, hi] = [Math.min(from, to), Math.max(from, to)];
      const mid = (lo + hi) / 2;
      for (const shift of SHIFTS) {
        const [start, end] = [{ x: ax + shift, y: from }, { x: bx + shift, y: to }];
        yield [start, end];
        for (let step = 0; step <= (hi - lo) / 2 - CLEARANCE; step += 8) {
          for (const y of step === 0 ? [mid] : [mid - step, mid + step]) yield [start, { x: start.x, y }, { x: end.x, y }, end];
        }
      }
      return;
    }
    const right = b.x >= a.x + a.width;
    const [start, end] = [{ x: right ? a.x + a.width : a.x, y: ay }, { x: right ? b.x : b.x + b.width, y: by }];
    const mx = (start.x + end.x) / 2;
    yield [start, { x: mx, y: start.y }, { x: mx, y: end.y }, end];
    const over = Math.min(a.y, b.y) - 2 * CLEARANCE;
    yield [{ x: ax, y: a.y }, { x: ax, y: over }, { x: bx, y: over }, { x: bx, y: b.y }];
    const under = Math.max(a.y + a.height, b.y + b.height) + 2 * CLEARANCE;
    yield [{ x: ax, y: a.y + a.height }, { x: ax, y: under }, { x: bx, y: under }, { x: bx, y: b.y + b.height }];
  }

  let first: Point[] | undefined;
  for (const line of tries()) {
    first ??= line;
    if (!blocked(line)) return line;
  }
  return first ?? [];
}

export function layoutGraph(view: GraphView, top = 0, options: LayoutOptions = {}): GraphLayout {
  const aspect = checkAspect(options.aspect);

  const groupOf = new Map(view.nodes.map((n) => [n.id, n.group] as const));
  const nodesIn = new Map<string, string[]>();
  for (const node of view.nodes) nodesIn.set(node.group, [...(nodesIn.get(node.group) ?? []), node.id]);
  const childrenOf = new Map<string | null, string[]>();
  for (const group of view.groups) childrenOf.set(group.parent, [...(childrenOf.get(group.parent) ?? []), group.id]);
  // A line between two cards of one box is drawn with that box's cluster; any other line is routed once everything is placed.
  const insideOf = new Map<string, { index: number; from: string; to: string }[]>();
  view.edges.forEach((edge, index) => {
    const group = groupOf.get(edge.from);
    if (group === undefined || group !== groupOf.get(edge.to)) return;
    insideOf.set(group, [...(insideOf.get(group) ?? []), { index, from: edge.from, to: edge.to }]);
  });

  // The clusters and lone cards of a box do not depend on the shape asked of the boxes, so they are laid out once.
  const own = new Map<string, Block[]>();
  const ownBlocks = (id: string): Block[] => {
    const known = own.get(id);
    if (known !== undefined) return known;
    const cards = nodesIn.get(id) ?? [];
    const edges = insideOf.get(id) ?? [];
    // The cards that refer to each other make a cluster; clusters are in the order of their first card.
    const parent = new Map(cards.map((c) => [c, c] as const));
    const find = (c: string): string => {
      let at = c;
      while (parent.get(at) !== at) at = parent.get(at) as string;
      return at;
    };
    for (const edge of edges) parent.set(find(edge.from), find(edge.to));
    const clusters = new Map<string, string[]>();
    for (const card of cards) clusters.set(find(card), [...(clusters.get(find(card)) ?? []), card]);
    const blocks = [...clusters.values()].map((members) => {
      const inCluster = new Set(members);
      const lines = edges.filter((e) => inCluster.has(e.from));
      return members.length === 1 && lines.length === 0 ? cardBlock(members[0] as string) : clusterBlock(members, lines);
    });
    own.set(id, blocks);
    return blocks;
  };

  /** What a box holds, its inner boxes packed toward `inner`; undefined when it holds nothing. */
  const build = (id: string, inner: number): Block | undefined => {
    const blocks = [...ownBlocks(id)];
    for (const child of childrenOf.get(id) ?? []) {
      const block = build(child, inner);
      if (block !== undefined) blocks.push(block);
    }
    if (blocks.length === 0) return undefined;

    const content = pack(blocks, inner).block;
    const width = content.width + 2 * PAD;
    const height = content.height + 2 * PAD + HEADER;
    const box: Block = { ...emptyPlaced(), width, height };
    absorb(box, content, PAD, PAD + HEADER);
    box.groups.set(id, { x: 0, y: 0, width, height });
    return box;
  };

  // Boxes packed toward the shape asked of the picture are often the wrong shape to pack into it (two boxes that are each
  // as wide as the picture stack into a tall one), so the boxes inside are tried at a few shapes and the best picture is kept.
  let all: Block = { ...emptyPlaced(), width: 0, height: 0 };
  let allCost = Number.POSITIVE_INFINITY;
  for (const factor of INNER_SHAPES) {
    const inner = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect * factor));
    const roots = (childrenOf.get(null) ?? []).flatMap((id) => build(id, inner) ?? []);
    const packed = pack(roots, aspect);
    if (packed.cost < allCost - 1e-9) {
      all = packed.block;
      allCost = packed.cost;
    }
  }

  // Move everything so that the top-left of what is drawn is at the margin, below `top`.
  const placed = emptyPlaced();
  absorb(placed, all, MARGIN, MARGIN + top);
  const nodes = new Map([...placed.nodes].map(([id, b]) => [id, { ...b, x: round(b.x), y: round(b.y) }]));
  const groups = new Map([...placed.groups].map(([id, b]) => [id, { ...b, x: round(b.x), y: round(b.y) }]));
  const cards = [...nodes.values()];
  const edges = view.edges.map((edge, i) => {
    const line = placed.edges.get(i);
    if (line !== undefined) return line;
    const [from, to] = [nodes.get(edge.from), nodes.get(edge.to)];
    return from && to ? route(from, to, cards) : [];
  });
  const lines = edges.map((line) => line.map((p) => ({ x: round(p.x), y: round(p.y) })));

  const boxes = [...nodes.values(), ...groups.values()];
  const reach = [...boxes.map((b) => b.x + b.width), ...lines.flat().map((p) => p.x)];
  const low = [...boxes.map((b) => b.y + b.height), ...lines.flat().map((p) => p.y)];
  return { nodes, groups, edges: lines, width: Math.max(0, ...reach) + MARGIN, height: Math.max(0, ...low) + MARGIN };
}
