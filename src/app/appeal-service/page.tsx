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
 * The member picks one of their own claims that carries a COMPOSED appeal (the
 * free tool's ground selection + adoption); anything else is refused honestly.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { LearnFooter, LearnHeader } from "@/components/learn/LearnChrome";

interface ClaimRow { id: string; date_of_service: string | null; provider_name: string | null }

export default function AppealServicePage() {
  const { user } = useAuth();
  const signedIn = !!user && !user.isAnonymous;
  const [open, setOpen] = useState<boolean | null>(null);
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [claimId, setClaimId] = useState("");
  const [sponsorCode, setSponsorCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string; engagementId?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await fetch("/api/dfy/entry-point");
      const j = (await r.json().catch(() => ({}))) as { enabled?: boolean };
      if (!cancelled) setOpen(j.enabled === true);
    })();
    return () => { cancelled = true; };
  }, []);

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
    setMsg(r.ok ? { tone: "ok", text: "Request received. We'll confirm we can take this one, then email you when your documents are ready to sign.", engagementId: j.engagementId } : { tone: "err", text: j.error || "Something went wrong. Try again." });
  }

  let body: React.ReactNode;
  if (open === null) {
    body = <p className="text-sm text-gray-500">Loading…</p>;
  } else if (!open) {
    body = (
      <>
        <h1 className="text-2xl font-bold text-gray-900">Your appeal, handled.</h1>
        <p className="mt-2 text-sm text-gray-600">Not open yet. Until then, build and send your appeal free in Candid.</p>
        <Link href={signedIn ? "/claim" : "/auth/signup"} className="mt-4 inline-block text-sm font-semibold text-blue-700 hover:underline">{signedIn ? "Go to your claims →" : "Sign up free →"}</Link>
      </>
    );
  } else {
    body = (
      <div className="space-y-6">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-blue-600">Done for you</div>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">Your appeal, handled.</h1>
          <p className="mt-2 text-sm text-gray-600">You built your appeal. We take it from here.</p>
          <ul className="mt-2 space-y-1 text-sm text-gray-600">
            <li>• We prepare and submit your appeal as your authorized representative.</li>
            <li>• We work it until there is a decision and keep you posted the whole time.</li>
            <li>• If it goes to the state, we prepare the packet. You file it.</li>
          </ul>
          <p className="mt-2 text-sm font-semibold text-gray-900">Free during our California pilot. Limited spots.</p>
          <p className="mt-2 text-xs text-gray-500">You can always file on your own at no cost. Candid is not a law firm and doesn&apos;t give legal advice. What to argue stays your call.</p>
        </div>
        {signedIn ? (
          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <label className="block text-sm text-gray-700">Which claim?
              <select className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" value={claimId} onChange={(e) => setClaimId(e.target.value)}>
                <option value="">Choose the claim</option>
                {claims.map((c) => <option key={c.id} value={c.id}>{c.provider_name ?? "Claim"} · {c.date_of_service ?? "—"}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-sm text-gray-700">Employer code (optional)
              <input className="mt-1 w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm" value={sponsorCode} onChange={(e) => setSponsorCode(e.target.value)} placeholder="optional" />
            </label>
            <button disabled={!claimId || busy} onClick={() => void apply()} className="mt-4 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Sending…" : "Handle my appeal"}</button>
            {msg && <p className={`mt-3 text-sm ${msg.tone === "ok" ? "text-emerald-700" : "text-red-700"}`}>{msg.text}{msg.engagementId && <> <Link href={`/dfy/${msg.engagementId}`} className="font-semibold underline">Track it here</Link></>}</p>}
          </div>
        ) : (
          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <p className="text-sm text-gray-700">Sign up free, build your appeal, then hand it to us.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href="/auth/signup" className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white">Sign up</Link>
              <Link href="/auth/signin" className="rounded-xl border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700">Sign in</Link>
            </div>
          </div>
        )}
        <p className="text-xs text-gray-400">This product is not a substitute for the advice of an attorney.</p>
      </div>
    );
  }

  return (
    <div className="learn-page">
      <LearnHeader />
      <main className="learn-main">{body}</main>
      <LearnFooter />
    </div>
  );
}
