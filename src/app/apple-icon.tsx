import { ImageResponse } from "next/og";

// Raster fallback of src/app/icon.svg for iOS home screens (Apple ignores SVG
// icons). Generated once at build time; no text, so no font is fetched.

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
        }}
      >
        <svg width="150" height="150" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
          <rect x="2" y="6" width="28" height="20" rx="4" fill="#0e5c63" />
          <rect x="6" y="11" width="7" height="5" rx="1.2" fill="#ffffff" opacity="0.9" />
          <path d="M6 20.5h12M6 23h8" stroke="#ffffff" strokeWidth="1.6" strokeLinecap="round" opacity="0.75" />
          <path
            d="M22 14.5l2 2 3.5-4"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    ),
    { ...size },
  );
}
