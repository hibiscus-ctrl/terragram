// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { GraphCategory } from "./services.ts";

/**
 * The engine's own picture of a category: a line drawing on a 24 by 24 grid, drawn here and nowhere else, so
 * the engine ships no vendor art. A card shows it where no icon resolver gave a service icon. Each value is the
 * inside of an `<svg viewBox="0 0 24 24">`: stroked in `currentColor`, never filled, so the one who places it
 * chooses the colour. Fixed text, never built from anything a document says.
 */
export const CATEGORY_GLYPHS: Readonly<Record<GraphCategory, string>> = {
  // Three nodes joined to a hub.
  network: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 7.5v4.5M12 12l-5.2 5M12 12l5.2 5"/>',
  // A chip with pins.
  compute: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  // A drive: three bars.
  storage: '<rect x="4" y="4" width="16" height="4.5" rx="1"/><rect x="4" y="9.75" width="16" height="4.5" rx="1"/><rect x="4" y="15.5" width="16" height="4.5" rx="1"/><path d="M7 6.25h.01M7 12h.01M7 17.75h.01"/>',
  // A shield with a keyhole.
  identity: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><circle cx="12" cy="10.5" r="2"/><path d="M12 12.5v3"/>',
  // A cylinder.
  data: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  // Four tiles.
  other: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
};
