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
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { LearnFooter, LearnHeader } from "@/components/learn/LearnChrome";
import { useDfyEntry } from "@/lib/dfy/use-dfy-entry";

interface ClaimRow { id: string; date_of_service: string | null; provider_name: string | null }

const STEPS: ReadonlyArray<{ num: string; text: string }> = [
  { num: "01", text: "We prepare and submit your appeal as your authorized representative." },
  { num: "02", text: "We work it until there is a decision and keep you posted the whole time." },
  { num: "03", text: "If it goes to the state, we prepare the packet. You file it." },
];

const field = "mt-1.5 block w-full rounded-xl border border-gray-300 bg-white px-3.5 py-2.5 text-[15px] text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";

export default function AppealServicePage() {
  const { user } = useAuth();
  const signedIn = !!user && !user.isAnonymous;
  const open = useDfyEntry();
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [claimId, setClaimId] = useState("");
  const [sponsorCode, setSponsorCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string; engagementId?: string } | null>(null);

  useEffect(() => {
    if (!user || !signedIn) return;
    let cancelled = false;
    (async () => {
      const t = await user.firebaseUser.getIdToken();
      const r = await fetch("/api/claims", { headers: { Authorization: `Bearer ${t}` } });
      const j = (await r.json().catch(() => ({}))) as { claims?: Array<{ id: string; date_of_service: string | null; provider_name?: string | null; metadata?: { provider?: { name?: string } } }> };
      if (cancelled) return;
      setClaims((j.claims ?? []).map((c) => ({ id: c.id, date_of_service: c.date_of_service, provider_name: c.provider_name ?? c.metadata?.provider?.name ?? null })));
    })();
    return () => { cancelled = true; };
  }, [user, signedIn]);

  async function apply() {
    if (!user || !claimId) return;
    setBusy(true); setMsg(null);
    const t = await user.firebaseUser.getIdToken();
    const r = await fetch("/api/dfy/apply", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: JSON.stringify({ claimId, sponsorCode: sponsorCode || undefined }) });
    const j = (await r.json().catch(() => ({}))) as { error?: string; engagementId?: string };
    setBusy(false);
    setMsg(r.ok ? { tone: "ok", text: "Request received. Sign your documents now, and we'll confirm we can take this one.", engagementId: j.engagementId } : { tone: "err", text: j.error || "Something went wrong. Try again." });
  }

  return (
    <div className="learn-page">
      <LearnHeader />
      <main className="landing" style={{ flex: 1 }}>
        {open === null ? (
          <section className="section"><div className="section-narrow"><p className="section-sub">Loading…</p></div></section>
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
                        <select className={field} value={claimId} onChange={(e) => setClaimId(e.target.value)}>
                          <option value="">Choose the claim</option>
                          {claims.map((c) => <option key={c.id} value={c.id}>{c.provider_name ?? "Claim"} · {c.date_of_service ?? "—"}</option>)}
                        </select>
                      </label>
                      <label className="mt-5 block text-sm font-semibold text-gray-800">Employer code (optional)
                        <input className={`${field} max-w-xs`} value={sponsorCode} onChange={(e) => setSponsorCode(e.target.value)} placeholder="optional" />
                      </label>
                      <div className="hero-ctas" style={{ marginTop: 24 }}>
                        <button type="button" disabled={!claimId || busy} onClick={() => void apply()} className="btn btn-primary btn-xl" style={{ opacity: !claimId || busy ? 0.55 : 1 }}>{busy ? "Sending…" : "Handle my appeal"}</button>
                      </div>
                      {msg && (
                        <p className={`mt-4 text-[14px] ${msg.tone === "ok" ? "text-emerald-700" : "text-red-700"}`}>
                          {msg.text}{msg.engagementId && <> <Link href={`/dfy/${msg.engagementId}`} className="font-semibold underline">Sign now</Link></>}
                        </p>
                      )}
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
