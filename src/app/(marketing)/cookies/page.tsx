// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";

import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
  title: "Cookie Policy",
  description:
    "How Terragram uses cookies and similar technologies, kept deliberately minimal: sign-in and session, payment security at checkout, and consent-gated analytics. No advertising cookies.",
  alternates: { canonical: "/cookies" },
};

export default function CookiesPage() {
  return (
    <LegalShell
      current="/cookies"
      eyebrow="Legal"
      title="Cookie Policy"
      updated="9 July 2026"
      intro={
        <>
          Terragram is built to be cookie-light: we use only what&rsquo;s needed to keep you signed
          in, secure your payments, and measure usage in aggregate; never to advertise or track you
          across the web.
        </>
      }
    >
      <p>
        This policy explains how <strong>Terragram Ltd</strong> uses cookies and similar
        technologies on the Terragram site and workspace, and the choices you have. It sits
        alongside our full <Link href="/privacy">Privacy Policy</Link>, which describes everything
        else we do with your data.
      </p>

      <h2 id="what-are-cookies">What are cookies?</h2>
      <p>
        Cookies are small text files a website stores in your browser so it can recognise your
        device on later visits, for example to keep you signed in. We also use a few{" "}
        <em>similar technologies</em> that work much the same way, such as <code>localStorage</code>{" "}
        and <code>sessionStorage</code>, which let the application remember state in your browser.
        Throughout this policy, &ldquo;cookies&rdquo; covers all of these.
      </p>

      <h2 id="how-we-use-cookies">How we use cookies</h2>
      <p>We keep cookies to a minimum and use them only for three purposes:</p>
      <ul>
        <li>
          <strong>Strictly necessary</strong>: to sign you in and maintain your session, so the
          application works at all.
        </li>
        <li>
          <strong>Payment security</strong>: during checkout, to help our payment provider detect
          and prevent fraud.
        </li>
        <li>
          <strong>Analytics</strong>: to understand usage in aggregate so we can improve the
          product. We use consent-gated Google Analytics, which stays{" "}
          <strong>off until you accept</strong> the consent banner (decline and nothing is set),
          alongside cookieless Vercel Analytics, which sets no cookies at all.
        </li>
      </ul>
      <p>
        We do <strong>not</strong> use advertising cookies, and we do not use cookies to track you
        across other websites or build a marketing profile of you.
      </p>

      <h2 id="categories">Cookie categories</h2>
      <ul>
        <li>
          <strong>Strictly necessary</strong>: required for core functions such as authentication
          and session security. These cannot be switched off without breaking the service.
        </li>
        <li>
          <strong>Functional</strong>: remember choices and state to give you a smoother experience.
        </li>
        <li>
          <strong>Analytics</strong>: aggregate, privacy-friendly measurement of how the product is
          used.
        </li>
        <li>
          <strong>Marketing / advertising</strong>: we do <strong>not</strong> use these.
        </li>
      </ul>

      <h2 id="cookies-we-set">Cookies we set</h2>
      <p>The cookies and similar technologies you may encounter include:</p>
      <ul>
        <li>
          <strong>sb-access-token / sb-refresh-token</strong>: keep you signed in (Supabase, session
          / up to 30 days).
        </li>
        <li>
          <strong>__stripe_mid / __stripe_sid</strong>: payment fraud prevention (Stripe, ~1 year /
          session).
        </li>
        <li>
          <strong>_ga / _ga_&lt;id&gt;</strong>: aggregate analytics, set{" "}
          <strong>only after you accept</strong> the consent banner (Google Analytics, ~2 years).
          Decline and none are set; clear the <code>tg-analytics-consent</code> cookie to be asked
          again.
        </li>
      </ul>

      <h2 id="managing-cookies">Managing cookies</h2>
      <p>
        You can control and clear cookies through your browser settings, and most browsers let you
        block or delete them per site. Note that blocking <strong>strictly-necessary</strong>{" "}
        cookies will break sign-in and core parts of the service. Where a consent banner or
        preference centre is available, you can adjust your choices there.
      </p>

      <h2 id="changes">Changes to this policy</h2>
      <p>
        We may update this Cookie Policy from time to time, for example if we add a tool or change a
        provider. When we do, we&rsquo;ll revise the &ldquo;Last updated&rdquo; date above, and
        significant changes may be highlighted in the product.
      </p>

      <h2 id="contact">Contact</h2>
      <p>
        Questions about cookies or this policy? Email us at{" "}
        <a href="mailto:privacy@terragram.dev">privacy@terragram.dev</a>, or read the full{" "}
        <Link href="/privacy">Privacy Policy</Link> for more on how we handle your data.
      </p>
    </LegalShell>
  );
}
