import { ImageResponse } from "next/og";

// Generated favicon: the Terragram mark, a monospaced "TG" on the dark ink tile,
// matching <LogoMark/>. File-convention route, so Next wires <link rel="icon">.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#211D16",
        borderRadius: 8,
        color: "#FAF8F4",
        fontFamily: "monospace",
        fontSize: 15,
        fontWeight: 700,
        letterSpacing: "-0.02em",
      }}
    >
      TG
    </div>,
    { ...size },
  );
}
