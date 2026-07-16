"use client";

import "./landing.css";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { useFeatureFlag } from "@/lib/config/use-feature-flag";

export default function LandingPage() {
  const { user } = useAuth();
  const loggedIn = !!user;

  return (
    <div className="landing dirB">
      <TopNav loggedIn={loggedIn} />
      <Hero loggedIn={loggedIn} />
      <StatStrip />
      <FeaturedSuite />
      <HowItWorks />
      <MinorSuite />
      <FinalCTASection />
      <FooterV2 />
    </div>
  );
}

/* ── Icons (mirrors design lic set) ───────────────────────────────────── */
const ICON = {
  check: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 13l4 4L19 7" />
    </svg>
  ),
  chevR: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5l7 7-7 7" />
    </svg>
  ),
  warn: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 9v4M12 17h.01M10.3 3.86a2 2 0 0 1 3.4 0l8.2 14.06A2 2 0 0 1 20.2 21H3.8a2 2 0 0 1-1.7-3.08Z" />
    </svg>
  ),
  fileCheck: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M9 15l2 2 4-4" />
    </svg>
  ),
  heart: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  ),
  upload: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
    </svg>
  ),
};

/* ── Top nav ─────────────────────────────────────────────────────────── */
function CandidLogo() {
  return (
    <Link href="/" className="nav-brand">
      <span className="nav-logo">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 13l4 4L19 7" />
        </svg>
      </span>
      Candid
    </Link>
  );
}

function TopNav({ loggedIn }: { loggedIn: boolean }) {
  return (
    <header className="nav">
      <CandidLogo />
      <div className="nav-right">
        {loggedIn ? (
          <Link href="/dashboard" className="btn btn-ink">Dashboard {ICON.chevR}</Link>
        ) : (
          <>
            <Link href="/auth/signin" className="btn btn-ghost">Sign in</Link>
            <Link href="/auth/signup" className="btn btn-primary">Sign up</Link>
          </>
        )}
      </div>
    </header>
  );
}

/* ── Hero ────────────────────────────────────────────────────────────── */
function Hero({ loggedIn }: { loggedIn: boolean }) {
  const { enabled: freeStart } = useFeatureFlag("dispute_letters_free_start_v1");
  return (
    <section className="hero">
      <div className="hero-inner">
        <div className="hero-copy">
          <span className="eyebrow-pill">
            <span className="dot" />{" "}
            {freeStart
              ? "Free bill audit + dispute letter — no credit card required."
              : "Free bill audit — no credit card required"}
          </span>
          <h1 className="h-hero">
            What is the healthcare industry <span className="accent">hiding from you?</span>
          </h1>
          <p className="hero-sub">
            Catch billing errors. Find hidden benefits. Compare plans.
          </p>
          <div className="hero-ctas">
            <Link
              href={loggedIn ? "/upload" : "/auth/signup"}
              className="btn btn-primary btn-xl"
            >
              {loggedIn ? "Upload a bill" : "Sign up — it's free"} {ICON.chevR}
            </Link>
            <a href="#suite" className="btn btn-ghost btn-xl">See what you get</a>
          </div>
        </div>
        <HeroPeek />
      </div>
    </section>
  );
}

/* PeekImage — probes /public/landing/* via HEAD; renders the screenshot only
   when the file actually exists (response is an image). Otherwise falls back
   to the polished inline mockup. Probe-then-swap pattern avoids broken-img
   placeholders during dev. */
function PeekImage({ src, alt, fallback }: { src: string; alt: string; fallback: React.ReactNode }) {
  const [imgExists, setImgExists] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(src, { method: "HEAD" })
      .then((r) => {
        const ct = r.headers.get("content-type") ?? "";
        if (!cancelled && r.ok && ct.startsWith("image/")) setImgExists(true);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [src]);
  if (!imgExists) return <>{fallback}</>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} />;
}

function HeroPeek() {
  return (
    <div className="hero-peek">
      <div className="hero-peek-frame">
        <PeekImage
          src="/landing/hero-claim.png"
          alt="Candid Claim — bill audit detail with recovery breakdown"
          fallback={<HeroMockup />}
        />
      </div>
      <div className="hero-peek-glow" aria-hidden="true" />
    </div>
  );
}

/* Polished interim mockup of /claim dashboard summary until real screenshot lands.
   Matches the design's hero peek composition: title + sub + Review Dispute CTA,
   gradient recovery card with up-arrow, 4-stat grid, bottom tab strip. */
function HeroMockup() {
  const { enabled: freeStart } = useFeatureFlag("dispute_letters_free_start_v1");
  return (
    <div style={{ padding: "20px 22px 16px", background: "var(--bg-1)", fontFamily: "var(--font-sans), system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--fg-5)" }}>Candid Claim</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--fg-1)", marginTop: 4, letterSpacing: "-0.005em" }}>Your claim, in plain English</div>
          <div style={{ fontSize: 11.5, color: "var(--fg-4)", marginTop: 3, lineHeight: 1.4 }}>Every bill audited line by line. Every overcharge flagged. Every dollar tracked.</div>
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, marginLeft: 12 }}>
          {freeStart && (
            <span style={{ background: "#d1fae5", color: "#065f46", fontSize: 9, fontWeight: 700, padding: "3px 7px", borderRadius: 999, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Free
            </span>
          )}
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--bg-ink)", color: "#fff", fontSize: 10, fontWeight: 600, padding: "6px 10px", borderRadius: 999, whiteSpace: "nowrap" }}>
            Review Dispute Letter {ICON.chevR}
          </span>
        </div>
      </div>
      <div style={{ background: "linear-gradient(180deg, var(--bg-1), var(--success-bg))", borderRadius: 14, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 4, border: "1px solid #d1fae5", marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--success-ink)" }}>Potential Recovery</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ color: "var(--success-strong)", fontSize: 22, fontWeight: 700, lineHeight: 1 }}>↑</span>
          <span style={{ fontSize: 30, fontWeight: 700, color: "var(--fg-1)", letterSpacing: "-0.025em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>$2,527.27</span>
        </div>
        <div style={{ fontSize: 11, color: "var(--fg-4)" }}>Across 6 bills you uploaded, Candid found $2,527.27 you can recover — refunds and overcharges to dispute with your insurer and providers.</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 12 }}>
        {[
          { label: "Bills Analyzed",    num: "6", sub: "Uploaded" },
          { label: "Issues Flagged",    num: "3", sub: "Overcharges" },
          { label: "Needs Your Input",  num: "1", sub: "Choose from list" },
          { label: "Disputes Drafted",  num: "1", sub: "Ready to send" },
        ].map((s, i) => (
          <div key={i} style={{ padding: "10px 8px", background: "var(--bg-2)", borderRadius: 10, display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: 8.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--fg-5)" }}>{s.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--fg-1)", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{s.num}</div>
            <div style={{ fontSize: 9.5, color: "var(--fg-4)" }}>{s.sub}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 8, borderTop: "1px solid var(--border-1)" }}>
        <div style={{ display: "flex", gap: 14 }}>
          {[
            { label: "Bills",         n: 6, active: true },
            { label: "Discrepancies", n: 9, active: false },
            { label: "Disputes",      n: 1, active: false },
          ].map((t, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 600, color: t.active ? "var(--fg-1)" : "var(--fg-5)", paddingBottom: 4, borderBottom: t.active ? "2px solid var(--fg-1)" : "2px solid transparent" }}>
              {t.label} <span style={{ background: t.active ? "var(--bg-3)" : "transparent", padding: "1px 6px", borderRadius: 99, fontSize: 9.5 }}>{t.n}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 600, color: "var(--fg-4)" }}>
          {ICON.upload} <span style={{ fontSize: 10.5 }}>Upload bill</span>
        </div>
      </div>
    </div>
  );
}

/* Mini benefits-grid mockup for the /plan peek. */
function PlanMockup() {
  const benefits = [
    { name: "Preventive Care",  cite: "in-network", state: "verified",   detail: "$0 copay" },
    { name: "Physical Therapy", cite: "20 visits",  state: "verified",   detail: "$30 copay" },
    { name: "Acupuncture",      cite: "12 visits",  state: "community",  detail: "$40 copay" },
    { name: "Specialist Visit", cite: "office",     state: "verified",   detail: "$50 copay" },
  ];
  return (
    <div style={{ padding: 22, background: "var(--bg-1)" }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--fg-5)", marginBottom: 4 }}>Candid Plan</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: "var(--fg-1)", marginBottom: 16 }}>Benefits — Blue Shield Gold 80</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {benefits.map((b, i) => {
          const isVerified = b.state === "verified";
          return (
            <div key={i} style={{ border: "1px solid var(--border-2)", borderRadius: 14, padding: 14, background: "var(--bg-1)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-2)" }}>{b.name}</span>
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 99,
                  background: isVerified ? "var(--verified-bg)" : "var(--verified-soft)",
                  color: isVerified ? "#fff" : "var(--verified-ink)",
                  border: isVerified ? "0" : "1px solid var(--verified-ring)",
                  textTransform: "uppercase", letterSpacing: "0.04em",
                }}>{isVerified ? "Verified" : "Community"}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--fg-4)" }}>{b.detail}</div>
              <div style={{ fontSize: 10, color: "var(--fg-5)", marginTop: 4 }}>{b.cite}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Mini bill-audit mockup for the /claim peek. */
function ClaimMockup() {
  return (
    <div style={{ padding: 22, background: "var(--bg-1)" }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--fg-5)", marginBottom: 4 }}>Candid Claim</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: "var(--fg-1)", marginBottom: 14 }}>Bill audit — 3 charges</div>
      <StepVisualAudit />
    </div>
  );
}

/* Mini 3-plan compare mockup for the /compare peek. */
function CompareMockup() {
  const rows = [
    { label: "Premium / mo",    a: "$340", b: "$420", c: "$310", winner: "C" },
    { label: "Deductible",      a: "$1,500", b: "$500", c: "$3,000", winner: "B" },
    { label: "OOP max",         a: "$8,000", b: "$6,000", c: "$8,500", winner: "B" },
    { label: "PCP copay",       a: "$30",  b: "$20",  c: "$40",  winner: "B" },
  ];
  return (
    <div style={{ padding: 22, background: "var(--bg-1)" }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--fg-5)", marginBottom: 4 }}>Candid Compare</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: "var(--fg-1)", marginBottom: 14 }}>3 plans · side by side</div>
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr repeat(3, 1fr)", fontSize: 11, gap: "4px 8px", alignItems: "center" }}>
        {[
          <div key="corner-empty" />,
          ...["A", "B", "C"].map((k) => (
            <div key={`hdr-${k}`} style={{ display: "flex", alignItems: "center", gap: 4, fontWeight: 700, color: "var(--fg-2)" }}>
              <span style={{ width: 18, height: 18, borderRadius: "50%", background: k === "A" ? "var(--candid-blue-600)" : k === "B" ? "var(--success-strong)" : "var(--hsa-ink)", color: "#fff", fontSize: 9, display: "grid", placeItems: "center" }}>{k}</span>
              Plan {k}
            </div>
          )),
          ...rows.flatMap((r) => [
            <div key={`row-${r.label}-label`} style={{ color: "var(--fg-4)", fontSize: 11, padding: "4px 0", borderTop: "1px solid var(--border-1)" }}>{r.label}</div>,
            ...(["a", "b", "c"] as const).map((k) => {
              const isWinner = r.winner.toLowerCase() === k;
              return (
                <div key={`row-${r.label}-${k}`} style={{ borderTop: "1px solid var(--border-1)", padding: "4px 0", fontWeight: isWinner ? 700 : 500, color: isWinner ? "var(--success-ink)" : "var(--fg-2)", fontVariantNumeric: "tabular-nums" }}>
                  {r[k]}{isWinner && <span style={{ marginLeft: 4, fontSize: 9, background: "var(--success-bg)", color: "var(--success-ink)", padding: "1px 5px", borderRadius: 99, fontWeight: 700 }}>BEST</span>}
                </div>
              );
            }),
          ]),
        ]}
      </div>
    </div>
  );
}

/* ── Stat strip ──────────────────────────────────────────────────────── */
function StatStrip() {
  const stats = [
    { num: "3 in 4",  label: "medical bills contain errors",         cite: "Medical Billing Advocates of America" },
    { num: "$1,300",  label: "average overcharge on large bills",    cite: "NerdWallet / MBAA billing analysis" },
    { num: "92%",     label: "of covered preventive benefits go unused", cite: "CDC preventive services utilization data" },
  ];
  return (
    <div className="stats">
      <div className="stats-inner">
        {stats.map((s, i) => (
          <div className="stat-cell" key={i}>
            <div className="stat-num">{s.num}</div>
            <div className="stat-label">{s.label}</div>
            <div className="stat-cite"><span className="stat-cite-dot" />{s.cite}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Featured suite (3 free products) ────────────────────────────────── */
function FeaturedSuite() {
  const featured = [
    { id: "plan",    name: "Candid Plan",    tagline: "Find the benefits you're already paying for.", body: "Your policy covers more than you think. We surface the screenings, therapy, and HSA-eligible perks waiting to be used.", href: "/plan",    image: "/landing/peek-plan.png",    mockup: <PlanMockup /> },
    { id: "claim",   name: "Candid Claim",   tagline: "Catch every overcharge on every bill.",         body: "Snap a photo of your bill. We check every line, flag any errors, and draft the dispute letter — so you never overpay.",          href: "/claim",   image: "/landing/peek-claim.png",   mockup: <ClaimMockup /> },
    { id: "compare", name: "Candid Compare", tagline: "Pick the plan that actually fits your life.",   body: "Stack up to three plans side by side — premiums, deductibles, what's covered. Every number sourced from the real document.", href: "/compare", image: "/landing/peek-compare.png", mockup: <CompareMockup /> },
  ];
  return (
    <section className="section section-suite" id="suite">
      <div className="section-narrow section-center">
        <span className="section-eyebrow">The Candid Suite</span>
        <h2 className="section-title">Everything to stop overpaying</h2>
        <p className="section-sub">
          Three free tools, working together to get the right plan, the most benefits, and the
          lowest bills.
        </p>
        <div className="suite-featured-grid">
          {featured.map((s) => (
            <Link href={s.href} key={s.id} className="suite-featured">
              <div className="suite-featured-meta">
                <div className="suite-featured-head">
                  <span className="suite-featured-name">{s.name}</span>
                  <span className="suite-status free">Free</span>
                </div>
                <h3 className="suite-featured-tag">{s.tagline}</h3>
                <p className="suite-featured-body">{s.body}</p>
              </div>
              <div className="suite-featured-peek">
                <div className="suite-featured-peek-frame">
                  <PeekImage src={s.image} alt={`${s.name} preview`} fallback={s.mockup} />
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── How it works ────────────────────────────────────────────────────── */
function HowItWorks() {
  return (
    <section className="section" id="how">
      <div className="section-narrow section-center">
        <span className="section-eyebrow">How it works</span>
        <h2 className="section-title">Three steps. Real answers.</h2>
        <p className="section-sub">
          No spreadsheets, no calls to your insurer, no medical-billing degree required.
        </p>
        <div className="steps">
          <div className="step">
            <span className="step-num">01</span>
            <h3>Upload your documents</h3>
            <p>
              Snap a photo of your insurance card and upload your bills. We scan everything
              automatically to fill in your plan details.
            </p>
            <div className="step-visual"><StepVisualUpload /></div>
          </div>
          <div className="step">
            <span className="step-num">02</span>
            <h3>Get your audit + benefit information</h3>
            <p>
              We compare every charge to benchmarks, flag errors, and surface covered benefits
              you&apos;re leaving on the table — in seconds.
            </p>
            <div className="step-visual"><StepVisualAudit /></div>
          </div>
          <div className="step">
            <span className="step-num">03</span>
            <h3>Take action</h3>
            <p>
              Dispute letters, case files, benefit guides — everything you need to fight
              overcharges and get the most out of your plan.
            </p>
            <div className="step-visual"><StepVisualAction /></div>
          </div>
        </div>
      </div>
    </section>
  );
}

function StepVisualUpload() {
  return (
    <div style={{
      width: "85%", height: "82%",
      border: "2px dashed var(--border-3)",
      borderRadius: 12,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6,
      color: "var(--fg-4)",
      background: "var(--bg-1)",
      padding: 12,
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12,
        background: "var(--info-bg)", color: "var(--candid-blue-600)",
        display: "grid", placeItems: "center",
      }}>{ICON.upload}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-2)", whiteSpace: "nowrap" }}>Drop your bill here</div>
      <div style={{ fontSize: 11, color: "var(--fg-5)", whiteSpace: "nowrap" }}>PDF, JPG, or HEIC</div>
    </div>
  );
}

function StepVisualAudit() {
  const rows = [
    { n: "CT scan, abdomen",       c: "74177", st: "ok",   a: "$2,400" },
    { n: "Anesthesia, prolonged",  c: "01999", st: "flag", a: "$1,120" },
    { n: "Room & board, semi-priv",c: "0120",  st: "ok",   a: "$1,800" },
  ];
  return (
    <div style={{
      width: "85%", padding: "12px 14px", background: "var(--bg-1)",
      border: "1px solid var(--border-2)", borderRadius: 12,
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
          <div style={{ flex: 1, color: "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {r.n} <span style={{ color: "var(--fg-5)", fontFamily: "var(--font-mono), ui-monospace, monospace" }}>{r.c}</span>
          </div>
          {r.st === "flag" ? (
            <span style={{
              background: "var(--unverified-bg)", color: "var(--unverified-ink)",
              fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 99,
              border: "1px solid #fecaca",
            }}>FLAGGED</span>
          ) : (
            <span style={{
              background: "var(--success-bg)", color: "var(--success-ink)",
              fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 99,
            }}>OK</span>
          )}
          <span style={{ fontFamily: "var(--font-mono), ui-monospace, monospace", fontSize: 11, color: "var(--fg-2)", minWidth: 50, textAlign: "right" }}>{r.a}</span>
        </div>
      ))}
      <div style={{
        marginTop: 4, padding: "8px 10px",
        background: "var(--success-bg)", color: "var(--success-ink)",
        fontSize: 11, fontWeight: 700, borderRadius: 8,
        display: "flex", justifyContent: "space-between",
      }}>
        <span>POTENTIAL RECOVERY</span>
        <span style={{ fontFamily: "var(--font-mono), ui-monospace, monospace" }}>−$847.00</span>
      </div>
    </div>
  );
}

function StepVisualAction() {
  return (
    <div style={{ width: "85%", height: "85%", position: "relative" }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{
          position: "absolute", left: i * 14, top: i * 10,
          width: "78%", height: "85%",
          background: "var(--bg-1)",
          border: "1px solid var(--border-2)",
          borderRadius: 10,
          boxShadow: "0 8px 16px -4px rgba(15,23,42,0.08)",
          padding: 10,
        }}>
          {i === 2 && (
            <>
              <div style={{ height: 6, background: "var(--bg-3)", borderRadius: 3, width: "60%", marginBottom: 8 }} />
              <div style={{ height: 4, background: "var(--bg-3)", borderRadius: 3, width: "100%", marginBottom: 5 }} />
              <div style={{ height: 4, background: "var(--bg-3)", borderRadius: 3, width: "92%", marginBottom: 5 }} />
              <div style={{ height: 4, background: "var(--bg-3)", borderRadius: 3, width: "88%", marginBottom: 5 }} />
              <div style={{ height: 4, background: "var(--bg-3)", borderRadius: 3, width: "75%", marginBottom: 12 }} />
              <div style={{
                display: "inline-block", padding: "4px 8px",
                background: "var(--candid-blue-600)", color: "#fff",
                fontSize: 9, fontWeight: 700, borderRadius: 4,
              }}>SEND DISPUTE</div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── Minor suite (3 in-the-works products) ───────────────────────────── */
const MINOR = [
  {
    id: "case",
    name: "Candid Case",
    status: "beta" as const,
    tagline: "Build your case. Find your lawyer.",
    body: "Compile your audit, dispute letters, and evidence into a downloadable case file. Browse healthcare billing attorneys when you need one — no referral fees, ever.",
    href: "/case",
  },
  {
    id: "hsa",
    name: "Candid HSA",
    status: "beta" as const,
    tagline: "Pre-tax money, fully used.",
    body: "Find HSA/FSA-eligible benefits inside your plan, and shop a curated marketplace of products that qualify — telehealth, vision, therapy, and more.",
    href: "/hsa-marketplace",
  },
  {
    id: "care",
    name: "Candid Care",
    status: "soon" as const,
    tagline: "Compare costs. Find fair providers.",
    body: "See what other Candid users actually paid for the same procedure. Find providers who bill fairly — built on real, anonymized data from the community.",
    href: "/care",
  },
];

function MinorSuite() {
  const statusLabel = { beta: "Beta", soon: "Coming Soon", free: "Free" };
  return (
    <section className="section section-suite-minor">
      <div className="section-narrow section-center">
        <span className="section-eyebrow">Coming soon</span>
        <h2 className="section-title">More tools, more savings</h2>
        <p className="section-sub">In beta and on the way — built on the same plan and bill data.</p>
        <div className="suite-minor-grid" style={{ marginTop: 48 }}>
          {MINOR.map((s) => (
            <Link href={s.href} key={s.id} className="suite-minor">
              <div className="suite-minor-head">
                <span className="suite-minor-name">{s.name}</span>
                <span className={`suite-status ${s.status}`}>{statusLabel[s.status]}</span>
              </div>
              <div className="suite-minor-tag">{s.tagline}</div>
              <p className="suite-minor-body">{s.body}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Final CTA ───────────────────────────────────────────────────────── */
function FinalCTASection() {
  return (
    <section className="section">
      <div className="section-narrow">
        <div className="final-cta">
          <h2>You pay a lot for healthcare. Get the most out of it.</h2>
          <p>
            Free bill audit and benefits analysis. We&apos;ll tell you if you&apos;ve been
            overcharged and what your plan covers — in under five minutes.
          </p>
          <div style={{ display: "inline-flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
            <Link href="/auth/signup" className="btn btn-primary btn-xl">Sign up — it&apos;s free {ICON.chevR}</Link>
            <a
              href="#suite"
              className="btn btn-ghost btn-xl"
              style={{
                background: "rgba(255,255,255,0.08)", color: "#fff",
                border: "1px solid rgba(255,255,255,0.16)",
              }}
            >
              See what you get
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Footer v2 ───────────────────────────────────────────────────────── */
function FooterV2() {
  return (
    <footer className="foot-v2">
      <div className="foot-v2-inner">
        <div className="foot-v2-top">
          <div className="foot-v2-brand">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{
                width: 28, height: 28, background: "var(--candid-blue-600)",
                borderRadius: 7, display: "grid", placeItems: "center", color: "#fff",
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </span>
              <span style={{ fontSize: 18, fontWeight: 700, color: "var(--fg-1)", letterSpacing: "-0.01em" }}>Candid</span>
            </div>
            <div className="foot-v2-parent">An Airgetlam Labs LLC company.</div>
          </div>
          <nav className="foot-v2-links">
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/health-data">Health Data Privacy</Link>
            <Link href="/support">Support</Link>
          </nav>
        </div>
        <div className="foot-v2-disclaimer">
          Candid is not a healthcare provider, law firm, or insurance company. All outputs are
          informational and do not constitute legal, medical, or financial advice. Always consult a
          qualified professional. © {new Date().getFullYear()} Airgetlam Labs LLC. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
