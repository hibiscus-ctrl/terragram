import type { Metadata } from "next";

import { VerifyClient } from "@/components/verify/verify-client";

export const metadata: Metadata = {
  title: "Verify an evidence bundle",
  description:
    "Check a Terragram evidence bundle in your own browser. Nothing is uploaded: the hash is recomputed and the signature checked locally, against the public key the bundle carries.",
  alternates: { canonical: "/verify" },
};

// A plain div, not <main>: the marketing layout already provides the single
// #main-content <main> landmark this page streams into. A nested <main> would
// create a duplicate landmark and break the skip-to-content target.
export default function VerifyPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-14">
      <p className="font-mono text-2xs font-semibold tracking-[0.08em] text-cat-storage uppercase">
        Evidence
      </p>
      <h1 className="mt-2 text-[clamp(28px,4vw,38px)] leading-[1.1] font-extrabold tracking-[-0.02em] text-foreground">
        Verify an evidence bundle
      </h1>
      <p className="mt-4 max-w-2xl text-base leading-[1.6] text-muted-foreground">
        Drop a bundle here and this page checks it in your browser. The file is never
        uploaded and this page never calls Terragram. It recomputes the content hash from
        the model and plan inside the bundle, compares it with the receipt, and checks the
        signature against the public key the bundle carries — so the check still works if
        Terragram is unreachable, or gone.
      </p>

      <VerifyClient />
    </div>
  );
}
