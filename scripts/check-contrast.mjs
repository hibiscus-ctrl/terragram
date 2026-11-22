/**
 * Colour-contrast gate over the design tokens: assert what DESIGN.md promises,
 * "hold every surface to WCAG 2.2 AA", for the token pairs the product paints.
 *
 *   node scripts/check-contrast.mjs           — run the gate (CI)
 *   node scripts/check-contrast.mjs --report  — print every measured pair
 *
 * Reads the LITERAL hex values out of src/styles/globals.css — not a copy — so a
 * token edited without re-checking fails here rather than in an audit.
 *
 * Thresholds (WCAG 2.2):
 *   text        4.5:1  — SC 1.4.3. Every pair below is small text: this theme
 *                        retunes --text-xs to 13px and --text-2xs to 11px, so
 *                        nothing that wears these tokens qualifies for the 3:1
 *                        large-text allowance.
 *   non-text    3.0:1  — SC 1.4.11, for the visual information needed to identify
 *                        a control. Only borders that are the SOLE identifier of a
 *                        control are listed; decorative card edges and section
 *                        rules are exempt and deliberately absent.
 */
import { readFileSync } from "node:fs";

const cssPath = new URL("../src/styles/globals.css", import.meta.url);

/* ------------------------------------------------------------------ tokens -- */

/** Every `--name: #rrggbb;` declaration in the `:root` block, by name. */
function readTokens() {
  const css = readFileSync(cssPath, "utf8");
  const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("@theme inline"));
  const raw = new Map();
  for (const [, name, value] of rootBlock.matchAll(
    /--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8}|var\(--[a-z0-9-]+\))\s*;/g,
  )) {
    raw.set(name, value.toLowerCase());
  }
  // Resolve `var(--other)` aliases, so a token that re-points at another one is
  // measured as the colour it actually resolves to rather than being skipped.
  const tokens = new Map();
  for (const name of raw.keys()) {
    let value = raw.get(name);
    for (let hops = 0; value?.startsWith("var(") && hops < 8; hops++) {
      value = raw.get(value.slice("var(--".length, -1));
    }
    if (value?.startsWith("#")) tokens.set(name, value);
  }
  return tokens;
}

/* ---------------------------------------------------------------- contrast -- */

function toRgb(hex) {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h.slice(0, 6);
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
}

/** WCAG 2.x relative luminance. */
function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/* ------------------------------------------------------------------- pairs -- */

/**
 * `[foreground, background, threshold, what]`. Both sides are token names, so a
 * pair can never quietly measure a stale copy of a colour. White text written as
 * `text-white` is measured as `--primary-foreground` (#ffffff).
 *
 * Every entry is a pair that actually renders somewhere under src/.
 */
const PAIRS = [
  // ---- body copy on the page and on cards ----
  ["foreground", "background", 4.5, "body copy on the page"],
  ["foreground", "card", 4.5, "body copy on a card"],
  ["muted-foreground", "background", 4.5, "secondary copy on the page"],
  ["muted-foreground", "card", 4.5, "secondary copy (and input placeholders) on a card"],
  ["muted-foreground", "muted", 4.5, "secondary copy on a muted fill"],
  ["muted-foreground", "surface-subtle", 4.5, "secondary copy on a hover row"],
  ["muted-foreground", "surface-code", 4.5, "Demo data chip"],
  ["muted-foreground", "wash", 4.5, "secondary copy on the marketing band"],

  // ---- the warm ink ramp, where it carries real copy ----
  ["ink-soft", "background", 4.5, "subhead on the page"],
  ["ink-soft", "card", 4.5, "subhead on a card"],
  ["ink-muted", "card", 4.5, "dense secondary copy"],
  ["ink-faint", "card", 4.5, "non-essential meta on a card"],
  ["ink-faint", "background", 4.5, "non-essential meta on the page"],

  // ---- the terracotta action colour, as text and as a fill ----
  ["primary", "background", 4.5, "link / active nav on the page"],
  ["primary", "card", 4.5, "link on a card"],
  ["primary", "surface-sunken", 4.5, "terracotta label on a sunken chip"],
  ["primary-hover", "card", 4.5, "emphasis text on a card"],
  ["primary-foreground", "primary", 4.5, "Button variant=default, the Popular pill"],
  ["secondary-foreground", "secondary", 4.5, "Button variant=secondary"],
  ["accent-foreground", "accent", 4.5, "ghost / outline button hover"],
  ["destructive-foreground", "destructive", 4.5, "Button variant=destructive"],
  ["destructive", "card", 4.5, "field error text on a card"],

  // ---- semantic status chips and fills ----
  ["success", "success-bg", 4.5, "success chip"],
  ["warning", "warning-bg", 4.5, "warning chip"],
  ["danger", "danger-bg", 4.5, "danger chip"],
  ["info", "info-bg", 4.5, "info chip"],
  ["success", "card", 4.5, "text-success on a card"],
  ["warning", "card", 4.5, "text-warning on a card"],
  ["danger", "card", 4.5, "text-danger on a card"],
  ["primary-foreground", "success", 4.5, "white label on a success fill (plan badge, step tick)"],
  ["primary-foreground", "warning", 4.5, "white glyph on a warning fill (flagged node)"],

  // ---- the node-category legend, label ink on its own tint ----
  ["cat-compute", "cat-compute-bg", 4.5, "compute label on its tint"],
  ["cat-network", "cat-network-bg", 4.5, "network label on its tint"],
  ["cat-storage", "cat-storage-bg", 4.5, "storage label on its tint"],
  ["cat-security", "cat-security-bg", 4.5, "security label on its tint"],
  ["cat-observability", "cat-observability-bg", 4.5, "observability label on its tint"],
  ["cat-neutral", "cat-neutral-bg", 4.5, "neutral label on its tint"],
  ["cat-compute", "card", 4.5, "compute eyebrow on a canvas node"],
  ["cat-network", "card", 4.5, "network eyebrow on a canvas node"],
  ["cat-storage", "card", 4.5, "storage eyebrow on a canvas node"],
  ["cat-security", "card", 4.5, "security eyebrow on a canvas node"],
  ["cat-observability", "card", 4.5, "observability eyebrow on a canvas node"],
  ["cat-neutral", "card", 4.5, "neutral eyebrow on a canvas node"],

  // ---- text on the dark emphasis material ----
  ["surface-foreground", "surface", 4.5, "body copy on a dark band"],
  ["surface-foreground", "surface-2", 4.5, "body copy on a raised dark step"],
  ["surface-muted", "surface", 4.5, "muted copy on a dark band"],
  ["surface-muted", "surface-2", 4.5, "muted copy on a raised dark step"],

  // ---- SC 1.4.11: borders that are the sole identifier of a control ----
  ["input", "card", 3, "form-field border (input, select)"],
  ["input", "background", 3, "outline-button border on the page"],
  ["ring", "card", 3, "focus ring on a card"],
  ["ring", "background", 3, "focus ring on the page"],
];

/**
 * Pairs that render today and fall short, keyed `fg on bg`, each with the reason
 * it is not fixed in the token. They are reported, not failed — and an entry
 * that starts PASSING fails the gate, so this list can only shrink. Do not add
 * to it to land a new token; fix the token.
 */
/** @type {Map<string, string>} */
const KNOWN_SHORTFALLS = new Map();

/* -------------------------------------------------------------------- run -- */

const tokens = readTokens();
const report = process.argv.includes("--report");
const errors = [];
const known = [];
const rows = [];

for (const [fg, bg, min, what] of PAIRS) {
  const fgHex = tokens.get(fg);
  const bgHex = tokens.get(bg);
  if (!fgHex || !bgHex) {
    errors.push(
      `  unknown token in pair (${fg} on ${bg}) — ${!fgHex ? `--${fg}` : `--${bg}`} is not declared in globals.css`,
    );
    continue;
  }
  const r = ratio(fgHex, bgHex);
  const key = `${fg} on ${bg}`;
  rows.push({ fg, bg, r, min, what, ok: r >= min });
  const line = `  ${what}\n      --${fg} ${fgHex} on --${bg} ${bgHex} = ${r.toFixed(2)}:1, needs ${min}:1`;
  if (KNOWN_SHORTFALLS.has(key)) {
    if (r >= min) {
      errors.push(`${line}\n      now passes — remove "${key}" from KNOWN_SHORTFALLS.`);
    } else {
      known.push(line);
    }
  } else if (r < min) {
    errors.push(line);
  }
}

for (const key of KNOWN_SHORTFALLS.keys()) {
  if (!PAIRS.some(([fg, bg]) => `${fg} on ${bg}` === key)) {
    errors.push(`  KNOWN_SHORTFALLS entry "${key}" matches no pair in PAIRS — remove it.`);
  }
}

if (report) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad("ratio", 8)}${pad("min", 5)}${pad("pair", 46)}what`);
  for (const row of rows.sort((a, b) => a.r - b.r)) {
    console.log(
      `${pad(`${row.r.toFixed(2)}${row.ok ? "" : " !"}`, 8)}${pad(row.min, 5)}${pad(`--${row.fg} on --${row.bg}`, 46)}${row.what}`,
    );
  }
  console.log("");
}

if (known.length) {
  console.warn(
    `check-contrast: ${known.length} known shortfall${known.length === 1 ? "" : "s"} (see KNOWN_SHORTFALLS):\n`,
  );
  console.warn(`${known.join("\n\n")}\n`);
}

if (errors.length) {
  console.error(
    `check-contrast: ${errors.length} token pair${errors.length === 1 ? "" : "s"} below the WCAG AA threshold.\n`,
  );
  console.error(errors.join("\n\n"));
  console.error(
    "\nFix the token in src/styles/globals.css, or — if the pair genuinely does not render — remove it from PAIRS in scripts/check-contrast.mjs with a comment saying why.\n",
  );
  process.exit(1);
}

console.log(`check-contrast: ${rows.length - known.length} token pairs clear their WCAG AA threshold.`);
