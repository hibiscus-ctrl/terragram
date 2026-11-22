import type { Metadata } from "next";
import Link from "next/link";

import { Callout } from "@/components/content/callout";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
  title: "Accessibility",
  description:
    "Terragram's accessibility statement: partial conformance with WCAG 2.2 AA, what is built in, the limitations we know about, and how to tell us when something blocks you.",
  alternates: { canonical: "/accessibility" },
};

/**
 * The accessibility statement — the artefact procurement asks for (EN 301 549 /
 * WCAG 2.2 AA), separate from the practice, which is implemented across the tree.
 *
 * Deliberately claims only PARTIAL conformance and names its own gaps: this page
 * is read by buyers who will check it against the product, and an overstated
 * statement is worse than none. Update "Known limitations" when one is fixed, and
 * the `updated` date whenever the statement is reviewed.
 */
export default function AccessibilityPage() {
  return (
    <LegalShell
      current="/accessibility"
      eyebrow="Trust"
      title="Accessibility"
      updated="11 September 2026"
      intro={
        <>
          Terragram is built for teams across the NHS, central and local government, universities
          and charities — people for whom an inaccessible tool is not an inconvenience but a
          barrier to doing their job. This statement says how far we have got, and where we
          have not got far enough.
        </>
      }
    >
      <Callout tone="caution" title="Partial conformance, honestly stated">
        Terragram is <strong>partially conformant</strong> with WCAG 2.2 level AA. Partially
        conformant means some parts do not yet fully conform. The specific parts are listed under{" "}
        <a href="#known-limitations">known limitations</a> rather than left for you to discover.
      </Callout>

      <h2 id="scope">What this statement covers</h2>
      <p>
        This statement applies to the Terragram web application and the public site at the same
        domain: the marketing and documentation pages, sign-in and sign-up, the workspace (chat,
        canvas, review gate, code and evidence panes), the billing and settings screens, and the
        offline <Link href="/verify">bundle verifier</Link>.
      </p>
      <p>
        It does not cover the Terraform or OpenTofu that Terragram generates, which is your code
        running in your own tooling, nor third-party services you reach from Terragram (your cloud
        provider&rsquo;s console, GitHub, GitLab or Stripe), each of which publishes its own
        statement.
      </p>

      <h2 id="standard">The standard we hold ourselves to</h2>
      <p>
        <strong>WCAG 2.2 level AA</strong>, which is the technical standard referenced by the{" "}
        <strong>
          Public Sector Bodies (Websites and Mobile Applications) Accessibility Regulations 2018
        </strong>{" "}
        and by <strong>EN 301 549</strong>, the harmonised European standard used in UK public
        procurement. If you are a public sector body, this is the standard you are required to meet
        when you publish a service built with Terragram, and it is the standard we build to so that
        Terragram itself is never the reason you fall short.
      </p>

      <h2 id="what-is-built-in">What is built in</h2>
      <p>These hold across the site and the application, not on selected pages:</p>
      <ul>
        <li>
          <strong>Keyboard operation.</strong> Every control is reachable and operable from the
          keyboard, including the navigation menus, the mobile menu, dialogs and the file pickers.
          Dialogs move focus in, trap it while open, close on <code>Escape</code>, and return focus
          to the control that opened them.
        </li>
        <li>
          <strong>Skip to main content.</strong> The first focusable element on every page is a
          skip link that jumps past the header to the page&rsquo;s single <code>main</code>{" "}
          landmark.
        </li>
        <li>
          <strong>Visible focus.</strong> Focus is never removed, only restyled — a 3px ring that
          meets the non-text contrast threshold against every surface it appears on.
        </li>
        <li>
          <strong>Landmarks and headings.</strong> One <code>h1</code> per page, headings that
          descend without skipping a level, and labelled <code>header</code>, <code>nav</code>,{" "}
          <code>main</code> and <code>footer</code> landmarks.
        </li>
        <li>
          <strong>Forms.</strong> Every field has a visible or programmatically associated label.
          Errors appear next to the field, are linked to it with <code>aria-describedby</code>,
          mark it <code>aria-invalid</code>, and move focus to the first field that needs
          attention — never a summary at the top that leaves you hunting.
        </li>
        <li>
          <strong>Status messages.</strong> Results that appear without a page change — a bundle
          verification, a generated plan, a toast — are announced through live regions rather than
          only appearing on screen.
        </li>
        <li>
          <strong>Colour is never the only signal.</strong> Flagged components, verification
          outcomes and review states each carry text and an icon as well as a colour.
        </li>
        <li>
          <strong>Contrast.</strong> Body and interface text meets 4.5:1, large text and interface
          boundaries meet 3:1, measured against the surfaces they actually appear on rather than
          against white.
        </li>
        <li>
          <strong>Reduced motion.</strong> Transitions and animation honour{" "}
          <code>prefers-reduced-motion</code>.
        </li>
        <li>
          <strong>Zoom and reflow.</strong> Layout is fluid rather than fixed-width, and zoom is
          never disabled. Reflow without horizontal scrolling is verified down to a 360px-wide
          viewport; see the note on 320px under{" "}
          <a href="#how-this-was-prepared">how this statement was prepared</a>.
        </li>
        <li>
          <strong>Plain English.</strong> The product exists so that describing infrastructure in
          ordinary words is enough; the interface copy is written the same way.
        </li>
      </ul>

      <h2 id="known-limitations">Known limitations</h2>
      <p>
        These are the parts that do not yet fully conform. Each one is a real limitation we have
        found ourselves, not a disclaimer:
      </p>
      <ul>
        <li>
          <strong>Repositioning nodes on the canvas needs a pointer.</strong> You can add,
          select, inspect, edit and delete a component from the keyboard, and every change the
          canvas can make is also reachable from the inspector — but dragging a node to a new
          position is pointer-only. Layout is presentational: it does not affect the model, the
          generated Terraform or the evidence bundle.
        </li>
        <li>
          <strong>The exported diagram SVG carries no text alternative.</strong> Use the review
          pane or the evidence bundle&rsquo;s JSON model, both of which describe every component
          and connection as text.
        </li>
        <li>
          <strong>Reading a screenshot needs a picture.</strong> The diagram importer works from an
          image, which some people cannot produce or check. Pasting a Mermaid flowchart, describing
          the architecture in chat, and pasting existing Terraform are all equivalent routes to the
          same model, and none of them requires sight of an image.
        </li>
        <li>
          <strong>Generated Terraform and code samples scroll horizontally.</strong> Long lines in
          the code pane and in documentation examples are placed in a scrollable region rather than
          wrapped. The download gives you the same content in a file your own editor can reflow.
        </li>
        <li>
          <strong>No independent audit yet.</strong> See how this was prepared, below.
        </li>
      </ul>

      <h2 id="feedback">Tell us when something blocks you</h2>
      <p>
        If you hit a barrier, or you need something in a different format, email{" "}
        <a href="mailto:support@terragram.dev">support@terragram.dev</a> and say what you were
        trying to do, what happened, and — if you know it — the assistive technology and browser
        you were using. You can also reach us through the{" "}
        <Link href="/contact">contact page</Link>.
      </p>
      <p>
        We aim to reply within <strong>2 business days</strong>. An accessibility barrier is
        treated as a defect, not a feature request: it is fixed or given a dated plan, and this
        statement is updated when it is.
      </p>

      <h2 id="enforcement">Enforcement</h2>
      <p>
        The Equality and Human Rights Commission (EHRC) enforces the Public Sector Bodies
        (Websites and Mobile Applications) Accessibility Regulations 2018. If you are unhappy with
        how we respond to your complaint, contact the{" "}
        <a href="https://www.equalityadvisoryservice.com/" target="_blank" rel="noreferrer">
          Equality Advisory and Support Service
        </a>
        , which handles enquiries on the EHRC&rsquo;s behalf.
      </p>

      <h2 id="how-this-was-prepared">How this statement was prepared</h2>
      <p>
        Prepared on <strong>11 September 2026</strong> following a self-assessment of the whole
        site and application. Testing combined automated checks (axe-core via Lighthouse, plus a
        contrast pass computed over the design tokens against the surfaces they render on) with
        manual keyboard-only walkthroughs of sign-in and the bundle verifier, at desktop and 390px
        mobile widths.
      </p>
      <p>
        Two things this round did not cover, stated rather than assumed:{" "}
        <strong>reflow at 320px and at 400% zoom</strong> was not measured (360px and above was),
        and the <strong>authenticated workspace</strong> had a token-level contrast pass and a code
        review rather than a full manual walkthrough. Both are the next checks, and this statement
        will say so when they are done.
      </p>
      <p>
        No independent third-party audit has been commissioned yet, and this statement does not
        claim one. When an audit is carried out, its date, scope and findings will be published
        here.
      </p>
    </LegalShell>
  );
}
