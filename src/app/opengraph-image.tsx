// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { ImageResponse } from "next/og";

// Default social card for link previews (Open Graph + Twitter). The root metadata
// declares the cards but shipped no image, so unfurls were bare. File-convention
// route → Next wires og:image / twitter:image automatically.
export const alt = "Terragram — from plain English to Terraform";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "90px 96px",
        background: "#211D16",
        color: "#F3EEE4",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <div
          style={{
            width: 76,
            height: 76,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#2B2620",
            border: "1px solid #3A342B",
            borderRadius: 18,
            color: "#FAF8F4",
            fontFamily: "monospace",
            fontSize: 34,
            fontWeight: 700,
            letterSpacing: "-0.02em",
          }}
        >
          TG
        </div>
        <div style={{ fontSize: 56, fontWeight: 700, letterSpacing: "-0.02em" }}>Terragram</div>
      </div>
      <div
        style={{
          display: "flex",
          fontSize: 68,
          fontWeight: 800,
          letterSpacing: "-0.03em",
          marginTop: 48,
          lineHeight: 1.05,
          maxWidth: 900,
        }}
      >
        From plain English to Terraform.
      </div>
      <div
        style={{ display: "flex", fontSize: 30, color: "#A39A88", marginTop: 28, lineHeight: 1.35, maxWidth: 860 }}
      >
        Plain English, diagrams and Terraform, one auditable model. A review gate and signed evidence.
        UK data residency.
      </div>
    </div>,
    { ...size },
  );
}
