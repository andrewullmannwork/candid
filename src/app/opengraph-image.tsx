import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt =
  "Candid Claim — find medical bill errors, discover benefits, save money";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          backgroundColor: "#ffffff",
          backgroundImage:
            "radial-gradient(900px 520px at 88% 4%, rgba(37,99,235,0.13), transparent 60%), radial-gradient(760px 560px at 2% 112%, rgba(124,58,237,0.07), transparent 55%)",
        }}
      >
        {/* Brand row + eyebrow pill */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: "58px",
                height: "58px",
                borderRadius: "15px",
                backgroundColor: "#2563eb",
                boxShadow: "0 12px 26px -6px rgba(37,99,235,0.6)",
              }}
            >
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#ffffff"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </div>
            <div
              style={{
                fontSize: "35px",
                fontWeight: 700,
                color: "#0f172a",
                letterSpacing: "-0.5px",
              }}
            >
              Candid Claim
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "9px",
              backgroundColor: "#eff6ff",
              color: "#1d4ed8",
              border: "1px solid #dbeafe",
              borderRadius: "999px",
              padding: "10px 20px",
              fontSize: "21px",
              fontWeight: 600,
            }}
          >
            <div
              style={{
                width: "9px",
                height: "9px",
                borderRadius: "50%",
                backgroundColor: "#2563eb",
              }}
            />
            Free medical bill audit
          </div>
        </div>

        {/* Hero */}
        <div
          style={{ display: "flex", flexDirection: "column", maxWidth: "1000px" }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              fontSize: "76px",
              fontWeight: 700,
              lineHeight: 1.02,
              letterSpacing: "-2px",
            }}
          >
            <span style={{ color: "#2563eb" }}>3 in 4&nbsp;</span>
            <span style={{ color: "#0f172a" }}>medical bills have errors.</span>
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              fontSize: "26px",
              lineHeight: 1.4,
              marginTop: "22px",
              maxWidth: "900px",
            }}
          >
            <span style={{ color: "#334155", fontWeight: 600 }}>
              See what your insurance is hiding.&nbsp;
            </span>
            <span style={{ color: "#6b7280" }}>
              Find medical bill errors. Discover benefits. Save money.
            </span>
          </div>
        </div>

        {/* Feature chips + domain */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", gap: "14px" }}>
            {[
              { label: "Bill audit", dot: "#2563eb" },
              { label: "Plan analysis", dot: "#059669" },
              { label: "Dispute letters", dot: "#d97706" },
            ].map((c) => (
              <div
                key={c.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "9px",
                  backgroundColor: "#ffffff",
                  border: "1px solid #e5e7eb",
                  borderRadius: "12px",
                  padding: "13px 19px",
                  fontSize: "21px",
                  fontWeight: 600,
                  color: "#374151",
                  boxShadow: "0 2px 6px rgba(15,23,42,0.05)",
                }}
              >
                <div
                  style={{
                    width: "10px",
                    height: "10px",
                    borderRadius: "50%",
                    backgroundColor: c.dot,
                  }}
                />
                {c.label}
              </div>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: "21px",
              color: "#9ca3af",
              fontWeight: 500,
            }}
          >
            candidclaim.com
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
