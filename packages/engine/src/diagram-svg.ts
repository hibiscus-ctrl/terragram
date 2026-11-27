// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { layoutPositions, NODE_HEIGHT, NODE_WIDTH } from "./layout.ts";
import { CATEGORY_META, EDGE_ACCESS_META, type EdgeAccess, type InfraModel, edgeAccessLabel } from "./model.ts";

/**
 * Render the laid-out model to a standalone SVG string — a real, dependency-free
 * diagram export (the node cards are HTML on the live canvas, so a DOM→image
 * capture would need a library; drawing the SVG from the same dagre positions gives
 * a clean vector export with no new dependency).
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function modelToSvg(model: InfraModel): string {
  const positions = layoutPositions(model);
  const nodes = model.nodes.map((node) => ({ node, position: positions.get(node.id) ?? { x: 0, y: 0 } }));
  const edges = model.edges;
  if (nodes.length === 0) return "";

  const pad = 32;
  const maxX = Math.max(...nodes.map((n) => n.position.x + NODE_WIDTH));
  const maxY = Math.max(...nodes.map((n) => n.position.y + NODE_HEIGHT));
  const width = Math.ceil(maxX + pad);
  const height = Math.ceil(maxY + pad);
  const pos = new Map(nodes.map((n) => [n.node.id, n.position]));

  const edgeLines = edges
    .map((e) => {
      const s = pos.get(e.source);
      const t = pos.get(e.target);
      if (!s || !t) return "";
      const x1 = s.x + NODE_WIDTH / 2;
      const y1 = s.y + NODE_HEIGHT;
      const x2 = t.x + NODE_WIDTH / 2;
      const y2 = t.y;
      const midY = (y1 + y2) / 2;
      const meta = e.access ? EDGE_ACCESS_META[e.access] : undefined;
      const stroke = meta ? meta.color : "#dad3c4";
      const strokeWidth = meta ? 2 : 1.5;
      const dash = meta?.dash ? ` stroke-dasharray="${meta.dash}"` : "";
      const line = `<path d="M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"${dash}/>`;
      if (!meta) return line;
      // The type is written on the line as well as coloured, so it survives greyscale and colour blindness.
      const lx = (x1 + x2) / 2;
      const label = edgeAccessLabel({ access: e.access as EdgeAccess, conditional: e.conditional, unconditional: e.unconditional });
      const labelWidth = label.length * 6 + 8;
      return `${line}<rect x="${lx - labelWidth / 2}" y="${midY - 8}" width="${labelWidth}" height="14" rx="3" fill="#faf8f4"/><text x="${lx}" y="${midY + 3}" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9" font-weight="600" fill="${meta.color}">${esc(label)}</text>`;
    })
    .join("");

  const nodeCards = nodes
    .map((n) => {
      const meta = CATEGORY_META[n.node.category];
      const border = n.node.flag ? "#b45309" : meta.color;
      const x = n.position.x;
      const y = n.position.y;
      return `<g>
  <rect x="${x}" y="${y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="9" fill="#ffffff" stroke="${border}" stroke-width="1.5"/>
  <circle cx="${x + 12}" cy="${y + 18}" r="3" fill="${meta.color}"/>
  <text x="${x + 22}" y="${y + 21}" font-family="'JetBrains Mono',monospace" font-size="9" font-weight="600" fill="${meta.color}" letter-spacing="0.5">${esc(meta.label.toUpperCase())}</text>
  <text x="${x + 12}" y="${y + 44}" font-family="'JetBrains Mono',monospace" font-size="12" font-weight="700" fill="#211d16">${esc(n.node.label.slice(0, 22))}</text>
</g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#faf8f4"/>
${edgeLines}
${nodeCards}
</svg>`;
}
