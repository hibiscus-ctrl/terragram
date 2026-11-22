---
name: Terragram
description: Warm light interface for translating plain English, diagrams and Terraform through one model
colors:
  background: "#faf8f4"
  foreground: "#211d16"
  card: "#ffffff"
  primary: "#a8512a"
  primary-hover: "#9a4420"
  primary-foreground: "#ffffff"
  secondary: "#f3efe6"
  secondary-foreground: "#3a342b"
  muted: "#f3efe6"
  muted-foreground: "#665e4f"
  accent: "#f3efe6"
  accent-foreground: "#2b2620"
  destructive: "#dc2626"
  border: "#e9e3d7"
  input: "#928873"
  ring: "#a8512a"
  ink: "#3a342b"
  ink-soft: "#4a4335"
  ink-muted: "#5d5647"
  ink-faint: "#746a5c"
  line: "#f3efe6"
  line-strong: "#e9e3d7"
  wash: "#f5f0e8"
  surface-subtle: "#fefbf4"
  surface-sunken: "#f3efe6"
  surface-code: "#f3eee4"
  surface: "#211d16"
  surface-2: "#2b2620"
  surface-3: "#2e2921"
  surface-foreground: "#e9e3d7"
  surface-muted: "#bfb7a9"
  surface-border: "#3a342b"
  surface-dot: "#34d399"
  success: "#065f46"
  success-bg: "#ecfdf5"
  warning: "#b45309"
  warning-bg: "#fef7ec"
  danger: "#b91c1c"
  danger-bg: "#fef2f2"
  info: "#1d4ed8"
  info-bg: "#eff4fe"
  cat-compute: "#047857"
  cat-compute-bg: "#ecfdf5"
  cat-network: "#2563eb"
  cat-network-bg: "#eff4fe"
  cat-storage: "#7c3aed"
  cat-storage-bg: "#f5f0fe"
  cat-security: "#b45309"
  cat-security-bg: "#fef7ec"
  cat-neutral: "#665e4f"
  cat-neutral-bg: "#f3efe6"
typography:
  display:
    fontFamily: "Source Sans 3, ui-sans-serif, system-ui, sans-serif"
    fontSize: "3rem"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Source Sans 3, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.125rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Source Sans 3, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.625rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Source Sans 3, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.05em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  2xl: "16px"
  full: "9999px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "16px"
  lg: "22px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.lg}"
    padding: "0 16px"
    height: "40px"
  button-dark:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.surface-foreground}"
    rounded: "{rounded.lg}"
    padding: "0 16px"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    rounded: "{rounded.lg}"
    padding: "0 16px"
    height: "40px"
  button-outline:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "0 16px"
    height: "40px"
  badge-compute:
    backgroundColor: "{colors.cat-compute-bg}"
    textColor: "{colors.cat-compute}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: "22px"
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "40px"
---

# Design System: Terragram

## 1. Overview

**Creative North Star: "The Cartographer's Table"**

Terragram draws the map of your infrastructure. You describe what you need in plain English, or sketch it, or hand it existing Terraform, and Terragram keeps the words, the diagram, and the code as three views of one model that never drift apart. The interface has to feel like a cartographer's table in daylight: a warm working surface, a legend of colour-coded parts, and a steady hand that shows its working before anything is committed. It is a drafting table, not a terminal at 2am.

The system is a warm light theme, and only a warm light theme. There is no dark mode. `colorScheme: light` is declared at the viewport so native controls and scrollbars render light even on a dark-OS device. Depth comes mostly from tonal warmth: a stack of graded cream surfaces stands in for elevation, and shadow appears only when something genuinely moves (a card lifting on hover, a modal detaching from the page, a dark code block sitting proud). Dark ink surfaces (`#211d16`) are not a second theme; they are an emphasis material for the bidirectional band, the workspace chrome, and code.

Two things separate Terragram from every other infra tool. First, **warmth**: it refuses the cold slate aesthetic on purpose. Second, and unlike a typical single-accent product, Terragram runs a deliberate **node-category palette** (emerald, blue, violet, amber) because colour here is load-bearing: it encodes resource type on the diagram, the way a legend colours a map. The single terracotta stays reserved for brand action (CTAs, links, focus), so category colour and action colour never compete.

This system explicitly rejects four looks (the anti-references in PRODUCT.md): the cold slate-and-cyan devtool dashboard, neon-on-black terminal cosplay, generic SaaS-cream with gradient blobs and glassmorphism, and enterprise-compliance beige with stock photos. It also rejects ad-hoc grays. Every neutral is a named warm token, chosen to pass WCAG 2.2 AA.

**Key Characteristics:**
- Warm cream canvas (`#faf8f4`), never white as the page.
- One terracotta accent (`#a8512a`) for action; a four-hue node-category legend for meaning.
- Source Sans 3 for voice, JetBrains Mono for labels, code, and the "TG" mark.
- Flat at rest; warm hover-lift on interactive cards; a deep overlay lift on modals.
- Light-only, by deliberate policy, not by omission.

## 2. Colors

A warm earthen base, a fired-terracotta brand accent, and a saturated-but-calm node-category legend for the diagram.

### Primary
- **Fired Terracotta** (`#a8512a`): The brand action colour. Primary buttons, links, active nav, focus rings, the accent under the wordmark. On hover and for emphatic text it deepens to **Kiln Brown** (`#9a4420`). Terracotta signals "do this" or "go here", never a data category.

### Node-Category Legend (the load-bearing set)
Colour-codes resource types on the canvas and in docs. Each has a saturated ink for the glyph/label and a tint for the node body. A hue means one category everywhere it appears.
- **Compute — Emerald** (`#047857` on `#ecfdf5`): servers, functions, containers.
- **Network — Blue** (`#2563eb` on `#eff4fe`): VPCs, subnets, load balancers, routing.
- **Storage — Violet** (`#7c3aed` on `#f5f0fe`): buckets, databases, volumes, diagram files.
- **Security — Amber** (`#b45309` on `#fef7ec`): IAM, secrets, key vaults, policy.
- **Neutral — Taupe** (`#665e4f` on `#f3efe6`): unclassified or generic nodes.

### Semantic Status
For app feedback, distinct from the category legend: **Success** (`#065f46` on `#ecfdf5`), **Warning** (`#b45309` on `#fef7ec`), **Danger** (`#b91c1c` on `#fef2f2`), **Info** (`#1d4ed8` on `#eff4fe`).

### Neutral
- **Warm Ink** (`#211d16`): Primary text and the near-black foreground. Never `#000`.
- **Sunlit Cream** (`#faf8f4`): The page canvas. The app is never on pure white.
- **Paper White** (`#ffffff`): Cards and popovers only.
- **Muted Taupe** (`#665e4f`): Secondary and body text. 6:1 on cream, the default for anything not a primary label.
- **Ink ramp** (`#3a342b` / `#4a4335` / `#5d5647`): Graded taupes for subheads and dense copy. **Faint Taupe** (`#746a5c`) is for placeholders and non-essential meta; it clears AA as text (5:1 on cream), but it is the quietest step and never carries body copy.
- **Warm lines** (`#e9e3d7` border/edge, `#f3efe6` inner divider): warmer than any neutral gray.
- **Surface tints** (`#fefbf4` subtle, `#f3efe6` sunken, `#f3eee4` code): tonal layering that stands in for shadow.

### Emphasis Surface
- **Dark Ink** (`#211d16`, steps `#2b2620` / `#2e2921`, border `#3a342b`, text `#e9e3d7`): the dark material for the bidirectional band, workspace chrome, footer, and code. A live green dot (`#34d399`) rides on it for the "data stays in the UK" cue.

### Named Rules
**The Legend Rule.** The node-category hues are a legend, not decoration. A hue maps to exactly one resource category everywhere, and it is always paired with a label or icon so meaning survives grayscale and colour-blindness. Never recolour a category for emphasis.

**The Terracotta-For-Action Rule.** Terracotta is the brand action colour: CTAs, links, focus, active state. It never encodes a data category or a status. When something both wants terracotta and is not an action, it is wrong.

**The No Raw Gray Rule.** No ad-hoc grays, no ad-hoc hex. Every neutral is a named warm token. `#888`, `text-gray-500`, `bg-[#f5f5f5]` are forbidden; if a shade is missing, add a token to `globals.css`.

## 3. Typography

**Display / Body Font:** Source Sans 3 (with `ui-sans-serif, system-ui, sans-serif`)
**Label / Mono Font:** JetBrains Mono (with `ui-monospace, SFMono-Regular, monospace`)

**Character:** Source Sans 3 is a warm, highly legible humanist sans that carries plain-language copy without a hint of corporate stiffness, exactly the register for "describe it like you would to a colleague". JetBrains Mono does double duty: it sets code and tokens, and it sets the small-caps eyebrow labels, which ties the interface to the Terraform it produces. The pairing reads as approachable and technical at once.

### Hierarchy
- **Display** (700, 3rem / `text-5xl` 48px, line-height 1.05, tracking -0.03em): Hero and page-defining headlines.
- **Headline** (700, 2.125rem / ~34px, tracking -0.02em): Section headings.
- **Title** (700, 1.625rem / `text-2xl` 26px, tracking -0.015em): Card and subsection titles.
- **Body** (400, 1.0625rem / 17px, line-height 1.55): Default copy. Cap measure at 65 to 75ch.
- **Eyebrow** (JetBrains Mono, 600, 0.6875rem / `text-2xs` 11px, tracking +0.05em, UPPERCASE): The signature mono kicker. Section labels, category tags, metadata. Often tinted terracotta or muted.
- **Mono** (400, 0.8125rem / `text-xs` 13px): Code, tokens, HCL, evidence hashes.

The Tailwind `text-*` scale is retuned to the brand ramp (2xs 11, xs 13, sm 15, 2xl 26, 5xl 48) so class names stay native while sizes follow the system. rem-based, so it honours the user's text-size setting.

### Named Rules
**The Mono-Eyebrow Rule.** Category and section labels are JetBrains Mono, 11px, 600, uppercase, +0.05em tracked. The mono eyebrow is the system's most recognisable typographic tell and ties the UI to the code it emits; never substitute a plain sans gray label.

**The Muted-For-Secondary Rule.** Secondary text is always `muted-foreground` (`#665e4f`), never a one-off lighter gray. Ad-hoc grays fail AA against the cream; the token does not. `ink-faint` is decorative only.

## 4. Elevation

Flat at rest, warm on movement. A card sits on the page as paper on a table (`#ffffff` on `#faf8f4`, a 1px warm border, no resting shadow). Shadow enters only as a response to state, and every shadow is warm-tinted brown-black, never neutral gray.

### Shadow Vocabulary
- **Hover Lift** (`box-shadow: 0 6px 18px rgba(46,38,24,0.08)`, up to `0 10px 26px rgba(46,38,24,0.1)`): interactive cards (mode cards, pricing cards) lift on hover, often with a `translateY(-2px)` and a border darkening to ink. This is the primary depth cue.
- **Overlay Lift** (`box-shadow: 0 24px 60px rgba(46,38,24,0.28)`): dialogs, sheets, and the settings panel. Deep and warm, for content detached from the page.
- **Code Lift** (`box-shadow: 0 14px 36px rgba(40,28,14,0.16)`): the dark code block, so the emphasis surface reads as sitting proud of the cream.
- **Toast** (`box-shadow: 0 8px 28px rgba(46,38,24,0.22)`): the floating confirmation pill.
- The primary CTA carries a subtle terracotta-tinted shadow (`0 4px 14px rgba(168,81,42,0.26)`), the one coloured shadow in the system.

### Named Rule
**The Warm-Hover-Lift Rule.** Cards are flat at rest and lift on hover with a warm-tinted shadow plus a small translate. Do not give a card a resting gray shadow, and never use a cold neutral-black shadow. If it looks like a 2014 Material card with `0 1px 3px rgba(0,0,0,0.2)`, it is wrong.

## 5. Components

Buttons are calm and tactile; cards invite interaction with a lift. The signature components are the mode card and the canvas node.

### Buttons
- **Shape:** 10px corners (`rounded-lg`), `font-semibold`, `transition-all`, 3px focus ring at `ring/40`.
- **Sizes:** default `h-10 px-4`, `sm` `h-8 px-3 text-xs`, `lg` `h-11 px-6`, `icon` `size-9`.
- **Primary:** terracotta fill, white text (5.3:1), subtle terracotta shadow. Hover dims via `brightness(0.94)`, not a colour swap.
- **Dark:** dark-ink surface, cream text, hover `brightness(1.12)`. The heavy-emphasis CTA on light bands.
- **Secondary / Outline / Ghost:** warm `#f3efe6` fill / 1px input border on transparent / bare text, each hovering to `accent`.
- **Loading:** the `loading` prop injects a `Loader2` spinner and sets `aria-busy`; never hand-roll a disabled-plus-spinner combination.

### Badges
- **Shape:** fully rounded pill (`rounded-full`), 1px border, `px-2.5 py-0.5`, `text-xs font-semibold`.
- **Category variants:** `compute` / `network` / `storage` / `security` / `neutral`, each pulling its legend triad. **Semantic variants:** `success` / `warning` / `danger` / `info`. **Neutral variants:** `default` (terracotta at 10%), `secondary`, `outline`, `dark`. An optional leading `dot` renders a 6px dot.

### Cards / Containers
- **Corner Style:** 14px (`rounded-xl`).
- **Background:** Paper White (`#ffffff`) on the cream page.
- **Border:** 1px warm `border` (`#e9e3d7`). This, not a resting shadow, is the card's edge.
- **Interactive cards:** lift on hover (see Elevation), border darkens toward ink.
- **Internal Padding:** 22px (`p-[22px]` / `p-6`); never nest a card inside a card, use a surface tint for inner regions.

### Inputs / Fields
- **Style:** `h-10`, 8px corners (`rounded-md`), 1px `input` border, Paper White fill, subtle `shadow-sm`.
- **Focus:** border shifts to `ring` (terracotta) plus a 3px `ring/30` halo. No glow, no scale.
- **Error:** `aria-invalid` swaps to the destructive border and a `destructive/25` ring.

### Dialogs, Sheets & Toasts
- **Dialogs:** 16px corners (`rounded-2xl`), Overlay Lift, `max-w-[460px]` to `[520px]`. Destructive confirmations always use the shared `ConfirmDialog`, never `window.confirm`.
- **Toasts:** dark-ink pill, cream text, live green dot, Toast shadow; auto-dismiss in 3 to 5s; `aria-live="polite"`, never steals focus.

### Mode Card (signature)
The workspace entry pattern ("What do you want to translate?"). A white 14px card holding a `from` chip, an arrow, and a `to` chip (using category/format colours), a bold title, and a one-line description. Lifts on hover with border darkening to ink. Four of them present the four modes.

### Canvas Node (signature)
A diagram node: a small rounded rect on white, a leading category dot (`compute` / `network` / `storage` / `security` colour), a JetBrains Mono label, connected by thin warm edges (`#dad3c4`, 1.6px, round caps). The node body tint and dot both come from the same category, so type reads instantly. Selected state uses a terracotta ring, never a category recolour.

### Navigation
- Warm cream header with the CSS logo lockup (dark "TG" tile + wordmark + terracotta underline). Active links in terracotta, inactive in foreground, hover to `accent`. Nav items: Product, Pricing, Docs, About, Contact, plus "Open the workspace". On mobile, nav collapses into a `Sheet`.

### Motion
- Keyframes: `fade-up` (0.35s, ease-out-quint `cubic-bezier(0.16,1,0.3,1)`), `fade-in` (0.25s), `spin-slow` (10s). Streaming node reveal draws the diagram in sequence and is a setting. State transitions are quiet; `prefers-reduced-motion` is honoured globally, collapsing everything to 0.01ms so handlers still fire. Never animate layout properties.

## 6. Do's and Don'ts

### Do:
- **Do** keep the page on Sunlit Cream (`#faf8f4`); reserve Paper White (`#ffffff`) for cards and popovers.
- **Do** use `muted-foreground` (`#665e4f`) for every piece of secondary text; reserve `ink-faint` for decorative meta.
- **Do** treat the node-category hues as a legend: one hue per category, always paired with a label or icon.
- **Do** keep terracotta for action only (CTAs, links, focus, active), never for a data category or status.
- **Do** set eyebrow labels in JetBrains Mono, 11px, uppercase, +0.05em.
- **Do** lift interactive cards on hover with a warm-tinted shadow; keep them flat at rest.
- **Do** convey depth with warm surface tints (`surface-subtle`, `surface-sunken`, `surface-code`) before reaching for a shadow.
- **Do** use the `ConfirmDialog` for destructive actions and the Button `loading` prop for async work.
- **Do** hold every surface to WCAG 2.2 AA: AA contrast, a visible 3px terracotta focus ring, honored `prefers-reduced-motion`, full keyboard paths, and a keyboard-operable canvas.

### Don't:
- **Don't** add a dark mode or dark variants. The product is light-only by policy; `colorScheme` is `light`.
- **Don't** use pure `#000` or `#fff` for text or page background.
- **Don't** inline arbitrary hex (`bg-[#f5f5f5]`) or use ad-hoc grays (`text-gray-500`); they fail AA on the cream and break the single source of truth.
- **Don't** give a card a resting shadow, and never use a cold neutral-black shadow. Warm-tinted, and only on movement.
- **Don't** recolour a node category for emphasis or invent a sixth category hue.
- **Don't** rely on colour alone to carry meaning on the canvas; the label is the signal, the hue is the aid.
- **Don't** nest cards, and don't reach for a modal before exhausting inline and progressive alternatives.
- **Don't** use gradient text, `background-clip: text`, glassmorphism, side-stripe `border-left` accents, or a big-number hero-metric block.
- **Don't** build a cold slate-and-cyan devtool dashboard or neon-on-black terminal cosplay; Terragram shows confidence through warm legibility, not by imitating a CLI.
- **Don't** drift into generic SaaS-cream with gradient blobs, or enterprise-compliance beige with navy headers and stock handshake photos. The warmth is earthen and specific.
- **Don't** use em dashes in UI copy; use commas, colons, or parentheses.
