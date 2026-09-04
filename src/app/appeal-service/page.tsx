/**
 * /appeal-service — the member-initiated entry point for done-for-you appeal
 * execution (S330, S324 plan §3.5). A PUBLIC route (middleware PUBLIC_ROUTES):
 * the homepage CTA lands logged-out visitors here, so the pitch renders for
 * everyone and the claim picker only for a signed-in full account (the apply
 * route itself refuses anonymous callers). Sells PROCESS, never outcomes: no
 * savings claims, no win rates, no "we fight for you" (the marketing rules
 * bind, and the homepage is the exhibit that defeats Gate 0). Dark until the
 * entry point is enabled; the pilot is invitation-only until then.
 *
 * Design: the landing page's own language (landing.css — eyebrow pill, section
 * title, the three-step cards, the primary button) inside the public chrome.
 */
"use client";

import "../landing.css";
import Link from "next/link";
import { Banner } from "@/components/banner";
import { memberRevisitNotice } from "@/lib/dfy/member-status";
import type { EngagementStatus } from "@/lib/dfy/engagement-state";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { LearnFooter, LearnHeader } from "@/components/learn/LearnChrome";
import { useDfyEntry } from "@/lib/dfy/use-dfy-entry";

/** The live engagement the apply endpoint reports when the member asks again. */
interface LiveEngagement {
  id: string;
  status: EngagementStatus;
  allSigned: boolean;
  composed: boolean;
  screened: { eligible: boolean; declineReason: string | null } | null;
  requestedAt: string | null;
}
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";

interface ClaimRow { id: string; date_of_service: string | null; provider_name: string | null; insurer_name?: string | null }

const STEPS: ReadonlyArray<{ num: string; text: string }> = [
  { num: "01", text: "We prepare and submit your appeal as your authorized representative." },
  { num: "02", text: "We work it until there is a decision and keep you posted the whole time." },
  { num: "03", text: "If it goes to the state, we prepare the packet. You file it." },
];

const field = "mt-1.5 block w-full rounded-xl border border-gray-300 bg-white px-3.5 py-2.5 text-[15px] text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";

export default function AppealServicePage() {
  const { user } = useAuth();
  const router = useRouter();
  const signedIn = !!user && !user.isAnonymous;
  const open = useDfyEntry();
  const [claims, setClaims] = useState<ClaimRow[] | null>(null);
  const [claimId, setClaimId] = useState("");
  const [sponsorCode, setSponsorCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string; engagementId?: string } | null>(null);
  // S331 — a repeat ask is answered with STATUS, not a refusal: where the
  // engagement stands and the day it was requested, in the one member
  // vocabulary (member-status).
  const [existing, setExisting] = useState<LiveEngagement | null>(null);

  useEffect(() => {
    if (!user || !signedIn) return;
    let cancelled = false;
    (async () => {
      const t = await user.firebaseUser.getIdToken();
      // fields=picker: id + provider + date only — the full list computes audits per claim and takes seconds
      const r = await fetch("/api/claims?fields=picker", { headers: { Authorization: `Bearer ${t}` } });
      const j = (await r.json().catch(() => ({}))) as { claims?: ClaimRow[] };
      if (cancelled) return;
      setClaims(j.claims ?? []);
    })();
    return () => { cancelled = true; };
  }, [user, signedIn]);

  async function apply() {
    if (!user || !claimId) return;
    setBusy(true); setMsg(null);
    const t = await user.firebaseUser.getIdToken();
    const r = await fetch("/api/dfy/apply", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: JSON.stringify({ claimId, sponsorCode: sponsorCode || undefined }) });
    const j = (await r.json().catch(() => ({}))) as { error?: string; engagementId?: string; engagement?: LiveEngagement | null };
    if (r.ok && j.engagementId) { router.push(`/dfy/${j.engagementId}`); return; }
    setBusy(false);
    if (j.engagement) { setExisting(j.engagement); setMsg(null); return; }
    setExisting(null);
    setMsg({ tone: "err", text: j.error || "Something went wrong. Try again." });
  }

  return (
    <div className="learn-page">
      <LearnHeader session={{ signedIn, label: signedIn ? user?.email ?? null : null }} />
      <main className="landing" style={{ flex: 1 }}>
        {open === null ? (
          <section className="section"><div className="section-narrow"><CubeLoaderBuilding className="min-h-[40vh]" /></div></section>
        ) : !open ? (
          <section className="section">
            <div className="section-narrow">
              <span className="section-eyebrow">Done for you</span>
              <h1 className="section-title">Your appeal, handled.</h1>
              <p className="section-sub">Not open yet. Until then, build and send your appeal free in Candid.</p>
              <div className="hero-ctas" style={{ marginTop: 28 }}>
                <Link href={signedIn ? "/claim" : "/auth/signup"} className="btn btn-primary btn-xl">{signedIn ? "Go to your claims" : "Sign up free"}</Link>
              </div>
            </div>
          </section>
        ) : (
          <>
            <section className="section" style={{ paddingBottom: 40 }}>
              <div className="section-narrow">
                <span className="eyebrow-pill"><span className="dot" /> Free during our California pilot. Limited spots.</span>
                <span className="section-eyebrow" style={{ display: "block" }}>Done for you</span>
                <h1 className="section-title">Your appeal, handled.</h1>
                <p className="section-sub">You built your appeal. We take it from here.</p>
                <div className="steps" style={{ marginTop: 40 }}>
                  {STEPS.map((s) => (
                    <div key={s.num} className="step" style={{ gap: 10 }}>
                      <span className="step-num">{s.num}</span>
                      <p style={{ margin: 0, fontSize: 17, lineHeight: 1.45, fontWeight: 600, color: "var(--fg-2)" }}>{s.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="section" style={{ paddingTop: 0 }}>
              <div className="section-narrow">
                <div className="step" style={{ maxWidth: 680, gap: 0 }}>
                  {signedIn ? (
                    <>
                      <label className="block text-sm font-semibold text-gray-800">Which claim?
                        {claims === null ? (
                          <div className="mt-1.5 flex h-[46px] items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 px-3.5"><CubeLoaderBuilding variant="inline" size={16} /><span className="h-3 w-40 animate-pulse rounded bg-gray-200" /></div>
                        ) : (
                          <select className={field} value={claimId} onChange={(e) => setClaimId(e.target.value)}>
                            <option value="">Choose the claim</option>
                            {claims.map((c) => <option key={c.id} value={c.id}>{c.provider_name ?? c.insurer_name ?? "Claim"} · {c.date_of_service ?? "—"}</option>)}
                          </select>
                        )}
                      </label>
                      <label className="mt-5 block text-sm font-semibold text-gray-800">Employer code (optional)
                        <input className={`${field} max-w-xs`} value={sponsorCode} onChange={(e) => setSponsorCode(e.target.value)} placeholder="optional" />
                      </label>
                      <div className="hero-ctas" style={{ marginTop: 24 }}>
                        <button type="button" disabled={!claimId || busy} onClick={() => void apply()} className="btn btn-primary btn-xl" style={{ opacity: !claimId ? 0.55 : 1, minWidth: 190 }}>{busy ? <CubeLoaderBuilding variant="inline" tone="onDark" /> : "Handle my appeal"}</button>
                      </div>
                      {msg && msg.tone === "err" && <p className="mt-4 text-[14px] text-red-700">{msg.text}</p>}
                      {existing && (() => {
                        const n = memberRevisitNotice(
                          { status: existing.status, allSigned: existing.allSigned, composed: existing.composed, screened: existing.screened },
                          existing.requestedAt,
                        );
                        return (
                          <div style={{ marginTop: 28 }}>
                            <Banner
                              tone={n.tone === "success" ? "success" : "info"}
                              size="md"
                              shape="card"
                              title={n.headline}
                              body={n.detail}
                            >
                              <p style={{ marginTop: 12, marginBottom: 0 }}>
                                <Link href={`/dfy/${existing.id}`} className="font-semibold underline">{n.ctaLabel} →</Link>
                              </p>
                            </Banner>
                          </div>
                        );
                      })()}
                    </>
                  ) : (
                    <>
                      <p style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--fg-2)" }}>Sign up free, build your appeal, then hand it to us.</p>
                      <div className="hero-ctas" style={{ marginTop: 20 }}>
                        <Link href="/auth/signup?intent=dfy" className="btn btn-primary btn-xl">Sign up</Link>
                        <Link href="/auth/signin" className="btn btn-ghost btn-xl">Sign in</Link>
                      </div>
                    </>
                  )}
                </div>
                <p className="section-sub" style={{ fontSize: 14, marginTop: 24 }}>You can always file on your own at no cost. Candid is not a law firm and doesn&apos;t give legal advice. What to argue stays your call.</p>
                <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--fg-5)" }}>This product is not a substitute for the advice of an attorney.</p>
              </div>
            </section>
          </>
        )}
      </main>
      <LearnFooter />
    </div>
  );
}
