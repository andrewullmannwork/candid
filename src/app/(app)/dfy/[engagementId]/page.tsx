/**
 * /dfy/[engagementId] — the MEMBER's signing surface (S330, handoff §3 P1).
 *
 * Five separate instruments, each read and signed on its own — never one
 * bundled click. The text shown is the exact instance the server hashes and
 * files. The authorization renders in the §56.11 form (14-point, separate).
 * After the stack is complete the engagement activates (fee-free during the
 * pilot, by sponsor code, or after the one-time payment) and the member's own
 * claim timeline carries every operator act from then on.
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { useAuth } from "@/lib/auth/auth-context";
import { LegalText } from "@/components/legal-text";
import { getStripeBrowser } from "@/lib/stripe/browser";

interface Instrument {
  type: string; title: string; version: string; effectiveDate: string; text: string; authorizationForm: boolean;
  signed: { signedName: string; signedAt: string } | null; pdfUrl: string | null;
}
interface Payload {
  engagement: { id: string; claimId: string; status: string; payer: string; sponsorRef: string | null };
  phase: string;
  screened: { eligible: boolean; declineReason: string | null } | null;
  composition: { groundSelected: boolean; letterAdopted: boolean };
  canSign: boolean;
  instruments: Instrument[];
  payment: { required: boolean; feeCents: number };
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function PayStep({ engagementId, token, onPaid }: { engagementId: string; token: () => Promise<string | null>; onPaid: () => void }) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const t = await token();
      if (!t) return;
      const res = await fetch(`/api/dfy/engagements/${engagementId}/pay`, { method: "POST", headers: { Authorization: `Bearer ${t}` } });
      const json = (await res.json().catch(() => ({}))) as { clientSecret?: string; error?: string };
      if (cancelled) return;
      if (!res.ok || !json.clientSecret) setErr(json.error || "Couldn't start payment. Try again.");
      else setClientSecret(json.clientSecret);
    })();
    return () => { cancelled = true; };
  }, [engagementId, token]);
  if (err) return <p className="text-sm text-red-600">{err}</p>;
  if (!clientSecret) return <p className="text-sm text-gray-500">Preparing payment…</p>;
  return (
    <Elements stripe={getStripeBrowser()} options={{ clientSecret, appearance: { theme: "stripe" } }}>
      <PayForm onPaid={onPaid} />
    </Elements>
  );
}
function PayForm({ onPaid }: { onPaid: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      onSubmit={async (ev) => {
        ev.preventDefault();
        if (!stripe || !elements) return;
        setBusy(true); setErr(null);
        const { error } = await stripe.confirmPayment({ elements, redirect: "if_required" });
        setBusy(false);
        if (error) setErr(error.message ?? "Payment failed. Try again.");
        else onPaid();
      }}
      className="space-y-3"
    >
      <PaymentElement />
      {err && <p className="text-sm text-red-600">{err}</p>}
      <button disabled={!stripe || busy} className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Paying…" : "Pay"}</button>
    </form>
  );
}

export default function DfySigningPage({ params }: { params: Promise<{ engagementId: string }> }) {
  const { user } = useAuth();
  const [engagementId, setEngagementId] = useState<string | null>(null);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [openType, setOpenType] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const token = useCallback(async () => (user ? user.firebaseUser.getIdToken() : null), [user]);
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { engagementId: id } = await params;
      const t = await user.firebaseUser.getIdToken();
      const res = await fetch(`/api/dfy/engagements/${id}`, { headers: { Authorization: `Bearer ${t}` } });
      if (cancelled) return;
      setEngagementId(id);
      if (!res.ok) { setError(res.status === 404 ? "This page isn't available." : "Couldn't load this page. Try again."); return; }
      const json = (await res.json()) as Payload;
      if (cancelled) return;
      setError(null);
      setData(json);
      const next = json.instruments.find((i) => !i.signed);
      setOpenType((cur) => cur ?? next?.type ?? null);
    })();
    return () => { cancelled = true; };
  }, [user, params, reloadKey]);

  async function cancel() {
    if (!engagementId || !user) return;
    if (!window.confirm("End this engagement? Within three business days of signing, any fee is refunded in full.")) return;
    setBusy(true); setError(null);
    const t = await token();
    const res = await fetch(`/api/dfy/engagements/${engagementId}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: JSON.stringify({}) });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) { setError(json.error || "Couldn't cancel. Try again."); return; }
    refresh();
  }

  async function sign(type: string) {
    if (!engagementId) return;
    const t = await token();
    if (!t) return;
    setBusy(true); setError(null);
    const res = await fetch(`/api/dfy/engagements/${engagementId}/sign`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({ type, signedName: name, accepted: true }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) { setError(json.error || "Couldn't sign. Try again."); return; }
    setChecked(false);
    setOpenType(null);
    refresh();
  }

  if (!data) {
    return <div className="mx-auto max-w-3xl p-6"><p className="text-sm text-gray-500">{error ?? "Loading…"}</p></div>;
  }
  const e = data.engagement;
  const total = data.instruments.length;
  const done = data.instruments.filter((i) => i.signed).length;
  const composed = data.composition.groundSelected && data.composition.letterAdopted;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-blue-600">Done for you</div>
        <h1 className="mt-1 text-2xl font-bold text-gray-900">Your appeal, handled.</h1>
        <p className="mt-2 text-sm text-gray-600">
          To have us submit your appeal, follow up, and track its deadlines as your authorized representative, read and sign the {total} documents below. Nothing happens until you do. You can always file on your own at no cost using Candid&apos;s free tools.
        </p>
        <p className="mt-2 text-xs text-gray-500"><Link href={`/claim?claim=${e.claimId}`} className="text-blue-700 hover:underline">← Back to your claim</Link></p>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {data.screened && !data.screened.eligible && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <b>We can&apos;t take this one on.</b> {data.screened.declineReason ?? ""} Your appeal and every free tool stay yours.
        </div>
      )}
      {e.status === "eligibility_pending" && !data.screened && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">We&apos;re confirming we can take this one on. Signing opens once approved.</div>
      )}

      {(e.status === "signed" || e.status === "active" || done > 0) && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm">
          <div className="font-semibold text-gray-900">{done} of {total} documents signed{e.status === "active" ? " · we're on it" : e.status === "signed" ? " · signed" : ""}</div>
          {e.status === "signed" && !composed && <p className="mt-1 text-gray-600">We start as soon as you&apos;ve built and adopted your appeal in the free tool. That part is yours.</p>}
          {e.status === "signed" && composed && data.payment.required && <p className="mt-1 text-gray-600">One step left: the ${(data.payment.feeCents / 100).toFixed(2)} fee.</p>}
          {e.status === "active" && <p className="mt-1 text-gray-600">Every step we take shows on your claim timeline as &quot;Done by Candid&quot;. Any decision stays yours. {data.phase && <span className="text-gray-500">Current phase: {data.phase}.</span>}</p>}
          {(e.status === "terminated" || e.status === "converted" || e.status === "completed") && <p className="mt-1 text-gray-600">{e.status === "completed" ? "This engagement is complete." : "This engagement has ended."}</p>}
        </div>
      )}

      {data.payment.required && engagementId && (
        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-semibold text-gray-900">The fee</h2>
          <p className="mt-1 text-sm text-gray-600">${(data.payment.feeCents / 100).toFixed(2)}, one time, for this claim only. The appeal itself is free. This fee pays for our preparation and submission work.</p>
          <div className="mt-3"><PayStep engagementId={engagementId} token={token} onPaid={() => setTimeout(refresh, 1500)} /></div>
        </section>
      )}

      <ol className="space-y-4">
        {data.instruments.map((inst, idx) => {
          const open = openType === inst.type;
          return (
            <li key={inst.type} className="rounded-2xl border border-gray-200 bg-white">
              <button type="button" onClick={() => setOpenType(open ? null : inst.type)} className="flex w-full items-start justify-between gap-3 p-5 text-left">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Document {idx + 1} of {total}</div>
                  <div className="mt-0.5 text-base font-semibold text-gray-900">{inst.title}</div>
                  <div className="mt-0.5 text-xs text-gray-500">Version {inst.version} · effective {inst.effectiveDate}</div>
                </div>
                <div className="shrink-0 text-right text-sm">
                  {inst.signed ? (
                    <span className="text-emerald-700">✓ signed {fmt(inst.signed.signedAt)}</span>
                  ) : (
                    <span className="text-gray-400">not yet signed</span>
                  )}
                  {inst.pdfUrl && <div><a href={inst.pdfUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-700 hover:underline">Signed PDF</a></div>}
                </div>
              </button>
              {open && (
                <div className="border-t border-gray-100 p-5">
                  <LegalText text={inst.text} variant={inst.authorizationForm ? "authorization" : "default"} />
                  {!inst.signed && data.canSign && (
                    <div className="mt-5 space-y-3 border-t border-gray-100 pt-4">
                      <label className="block text-sm text-gray-700">Type your full name to sign
                        <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Your full name" className="mt-1 w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                      </label>
                      <label className="flex cursor-pointer items-start gap-3 text-sm text-gray-700">
                        <input type="checkbox" checked={checked} onChange={(ev) => setChecked(ev.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300" />
                        <span>I&apos;ve read this {inst.title} in full and sign it electronically. I understand it is separate from the other documents on this page.</span>
                      </label>
                      <button disabled={!checked || name.trim().length < 2 || busy} onClick={() => void sign(inst.type)} className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Signing…" : `Sign ${inst.title}`}</button>
                    </div>
                  )}
                  {!inst.signed && !data.canSign && <p className="mt-4 text-sm text-gray-500">Signing opens once we confirm we can take this on.</p>}
                  {inst.type !== "health_data_upload" && engagementId && (
                    <p className="mt-3 text-xs text-gray-500">
                      Plan wants a handwritten signature?{" "}
                      <a href={`/api/dfy/engagements/${engagementId}/instrument?type=${inst.type}`} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline">Print this form</a>, sign it, and add the pages in <Link href="/upload" className="text-blue-700 hover:underline">Upload</Link>. Your signature here stays on file either way.
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {["eligibility_pending", "signed", "active"].includes(e.status) && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm">
          <div className="font-semibold text-gray-900">Changed your mind?</div>
          <p className="mt-1 text-gray-600">End this engagement any time. Cancel within three business days of signing and any fee is refunded in full. After that, your fee agreement&apos;s refund terms apply. Every free Candid tool stays yours.</p>
          <button disabled={busy} onClick={() => void cancel()} className="mt-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 disabled:opacity-50">End this engagement</button>
        </div>
      )}
      <p className="text-xs text-gray-400">This product is not a substitute for the advice of an attorney.</p>
    </div>
  );
}
