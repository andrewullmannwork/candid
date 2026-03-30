import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Candid Claim — Free Medical Bill Audit & Insurance Benefits Tool";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "linear-gradient(135deg, #1e40af 0%, #2563eb 50%, #3b82f6 100%)",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "60px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "24px",
          }}
        >
          <div
            style={{
              fontSize: 72,
              fontWeight: 800,
              color: "white",
              letterSpacing: "-2px",
            }}
          >
            Candid Claim
          </div>
          <div
            style={{
              fontSize: 32,
              fontWeight: 600,
              color: "rgba(255,255,255,0.95)",
              textAlign: "center",
              maxWidth: "800px",
              lineHeight: 1.3,
            }}
          >
            Free Medical Bill Audit
          </div>
          <div
            style={{
              fontSize: 20,
              color: "rgba(255,255,255,0.75)",
              textAlign: "center",
              maxWidth: "700px",
              lineHeight: 1.5,
              marginTop: "8px",
            }}
          >
            Find overcharges. Discover unused benefits. Draft dispute letters.
          </div>
          <div
            style={{
              display: "flex",
              gap: "32px",
              marginTop: "24px",
            }}
          >
            {["Bill Audit", "Plan Analysis", "Dispute Letters"].map((label) => (
              <div
                key={label}
                style={{
                  background: "rgba(255,255,255,0.15)",
                  borderRadius: "12px",
                  padding: "12px 24px",
                  fontSize: 18,
                  color: "white",
                  fontWeight: 500,
                }}
              >
                {label}
              </div>
            ))}
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            bottom: "30px",
            fontSize: 16,
            color: "rgba(255,255,255,0.5)",
          }}
        >
          candidclaim.com
        </div>
      </div>
    ),
    { ...size }
  );
}
