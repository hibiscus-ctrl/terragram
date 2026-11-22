"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE,
  type ConsentState,
  isConsentState,
} from "@/config/analytics";

import { GoogleAnalytics } from "./google-analytics";

function readConsent(): ConsentState | null {
  const entry = document.cookie.split("; ").find((part) => part.startsWith(`${CONSENT_COOKIE}=`));
  const value = entry?.slice(CONSENT_COOKIE.length + 1);
  return isConsentState(value) ? value : null;
}

function writeConsent(state: ConsentState) {
  // biome-ignore lint/suspicious/noDocumentCookie: a single first-party consent flag; CookieStore is async + unsupported on Safari
  document.cookie = `${CONSENT_COOKIE}=${state}; Max-Age=${CONSENT_MAX_AGE}; Path=/; SameSite=Lax`;
}

export function CookieConsent({ gaId }: { gaId: string }) {
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const stored = readConsent();
    setConsent(stored);
    setPending(stored === null);
  }, []);

  function choose(state: ConsentState) {
    writeConsent(state);
    setConsent(state);
    setPending(false);
  }

  return (
    <>
      {consent === "granted" && <GoogleAnalytics gaId={gaId} />}
      {pending && (
        <section aria-label="Cookie consent" className="fixed inset-x-0 bottom-0 z-50 px-4 pb-4">
          <div className="border-border bg-card mx-auto flex max-w-3xl flex-col gap-3 rounded-xl border p-4 shadow-[0_18px_44px_rgba(40,28,14,0.18)] sm:flex-row sm:items-center sm:gap-4">
            <p className="text-muted-foreground flex-1 text-xs leading-relaxed">
              We&rsquo;d like to set a Google Analytics cookie to measure aggregate
              usage and improve Terragram. Sign-in and payment cookies are always on; analytics is
              optional. See our{" "}
              <Link href="/cookies" className="text-primary underline underline-offset-2">
                Cookie Policy
              </Link>
              .
            </p>
            <div className="flex shrink-0 gap-2.5">
              <Button variant="outline" size="sm" onClick={() => choose("denied")}>
                Decline
              </Button>
              <Button size="sm" onClick={() => choose("granted")}>
                Accept
              </Button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
