# Product

## Register

product

Default register for PRODUCT.md is `product`: the diagram workspace is the surface that carries the value, and design serves the workflow. The marketing surface (`/`, `/pricing`, `/features`, `/about`, `/docs`, `/trust-center`, legal) is substantial; when working on those routes, override the register to `brand` for that task. Workspace, account, auth routes stay `product`.

## Users

Terragram is built for the UK public sector first, and open to everyone. Three overlapping audiences, one product:

- **Public-sector delivery teams** at NHS trusts, central government, local councils, universities, and charities. Often small teams who spend more time writing Terraform than deciding what to build, sometimes without a dedicated infra specialist. Their context: they can describe the system they need in plain English or sketch it, and they need it to become compliant, auditable cloud infrastructure without becoming Terraform experts first.
- **Platform / DevOps engineers** who do know Terraform, at SMEs and startups. Their context: they want to move faster between an idea, a diagram, and code, keep architecture docs that never drift from reality, and hand reviewers a diff they can actually read. They are technical and skeptical of magic; the tool has to show its working.
- **Reviewers, architects, and auditors** who sit at the review gate. Their context: approving what the model proposes before it becomes code, reading a signed evidence bundle, confirming data residency. They need legibility and provenance, not flash.

The job to be done: move between plain English, an architecture diagram, and Terraform in any direction, through one model that keeps all three in sync, with a human review gate before anything becomes code, and evidence an auditor will accept.

## Product Purpose

Terragram translates between three representations of infrastructure, plain English, architecture diagrams, and Terraform, through one internal model. Because all three flow through that single model, they never drift apart. It offers four modes (Chat → Diagram, Chat → Terraform, Diagram → Terraform, Terraform → Diagram), works bidirectionally, and targets AWS or Azure from the same model.

Two commitments are the product's spine and are never crossed:

- **The model is auditable, and a human holds the gate.** Nothing becomes committed code without passing a review gate; Terragram emits a signed evidence bundle (SBOM plus plan) so the decision is provable after the fact.
- **Data stays in the UK.** UK South / UK West residency and managed UK inference. This is a first-class promise, made for the public sector, kept for everyone.

Success looks like: someone who is not a Terraform expert describes what they need and merges compliant infrastructure they understand; an experienced engineer keeps a living diagram that matches their code; a reviewer approves at the gate with confidence and an auditor accepts the evidence without a follow-up call.

## Brand Personality

**Plain-spoken, trustworthy, credible.**

- **Plain-spoken**: plain language first. You describe infrastructure the way you would to a colleague; the product meets you there and never hides behind jargon. Clarity beats cleverness.
- **Trustworthy**: trust over cleverness. The model shows its working, flags what it is unsure about, and never lands code behind your back. The review gate and signed evidence are the proof.
- **Credible**: warm daylight, not a cold terminal. The interface reads as considered and humane, credible to a public-sector reviewer, without being corporate or dull.

Voice: calm, precise, human. Show, don't tell. No hype, no fear-selling, no wall of jargon.

## Anti-references

Terragram should NOT look like any of these:

- **A cold slate/cyan devtool dashboard.** The default Datadog/Grafana dark-slate infra aesthetic. Terragram is warm light, on purpose.
- **Neon-on-black terminal cosplay.** Hacker green-on-black security-tool tropes. Confidence is shown through legibility and evidence, not by cosplaying a CLI.
- **Generic SaaS-cream with gradient blobs.** Rounded purple gradients, blurry blob heroes, glassmorphism, the interchangeable startup landing page. Terragram's warmth is earthen and specific, never the default gradient-SaaS cream.
- **Enterprise-compliance beige with stock photos.** The dull GRC-vendor look: navy headers, stock handshake photos, dense legalese. Terragram is credible to a public-sector buyer without being boring or corporate.

## Design Principles

1. **Plain language first.** Anyone should be able to describe infrastructure and get somewhere. Copy, empty states, and defaults assume a capable non-expert, and never gatekeep with jargon.
2. **One model, no drift.** Words, diagram, and code are three views of a single source of truth. The interface's job is to keep them visibly in sync and make switching between them effortless.
3. **Trust over cleverness.** Show the working. Surface what the model is unsure about, keep the human review gate obvious, and make the signed evidence legible. Never optimise for a slick demo over an honest one.
4. **Sovereignty is visible.** "Data stays in the UK" is a feature, not fine print. Surfaces that touch residency, inference, or generated artifacts make the boundary obvious and reassuring.
5. **Open by default, accessible by default.** Open to everyone, and usable by everyone: keyboard and screen-reader readiness is a stated product value, not a retrofit.

## Accessibility & Inclusion

Commit to **WCAG 2.2 AA**. "Keyboard and screen-reader ready" is a product promise, so accessibility is a feature, not a checklist.

- Contrast meets AA against the warm cream canvas: this is why secondary text is always the `muted-foreground` token (6:1 on cream) rather than an ad-hoc lighter gray, which would fail. The faint taupe (`--ink-faint`) is reserved for decorative meta only.
- `prefers-reduced-motion` is honored globally: transitions and canvas/streaming animation collapse to near-instant while still firing end handlers.
- Visible focus is mandatory: a 3px terracotta focus ring on interactive elements, full keyboard paths, and the diagram canvas must be operable and readable without a pointer.
- The node-category palette must never rely on color alone: pair each category with a label or icon so meaning survives color-blindness and grayscale. The category hues are an aid, not the signal.
- Reviewers and auditors read the workspace and evidence with assistive tech: keep the canvas, tables, and evidence semantic, labeled, and wrapped in scroll containers.
