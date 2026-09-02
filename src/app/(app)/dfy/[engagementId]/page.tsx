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
import { useCallback, useEffect, useState, useRef } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { useAuth } from "@/lib/auth/auth-context";
import { LegalText } from "@/components/legal-text";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";
import { getStripeBrowser } from "@/lib/stripe/browser";

/** The on-screen signature face: system script fonts, cursive fallback — nothing to download. */
const SIGNATURE_FONT = '"Snell Roundhand", "Apple Chancery", "Savoye LET", "Brush Script MT", "Segoe Script", "URW Chancery L", cursive';

interface Instrument {
  /** Why this one cannot be signed yet (null = signable). */
  deferred?: string | null;
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
  /** Signatures shown as done before the server confirms them (type → who/when). */
  const [optimistic, setOptimistic] = useState<Record<string, { signedName: string; signedAt: string }>>({});
  const signQueue = useRef<Promise<void>>(Promise.resolve());
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
      setOptimistic({});
      const next = json.instruments.find((i) => !i.signed);
      setOpenType((cur) => cur ?? next?.type ?? null);
    })();
    return () => { cancelled = true; };
  }, [user, params, reloadKey]);

  async function cancel() {
    if (!engagementId || !user || !data) return;
    if (!window.confirm("End this engagement? Within three business days of signing, any fee is refunded in full.")) return;
    setError(null);
    // optimistic: the page ends the engagement now; the server confirms, or we put it back
    const prev = data;
    setData({ ...data, engagement: { ...data.engagement, status: "terminated" }, canSign: false });
    const t = await token();
    const res = await fetch(`/api/dfy/engagements/${engagementId}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: JSON.stringify({}) });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) { setData(prev); setError(json.error || "Couldn't cancel. Try again."); return; }
    refresh();
  }

  async function sign(type: string) {
    if (!engagementId || !data || name.trim().length < 2) return;
    setError(null);
    // optimistic: the card flips to signed the moment the box is ticked and the
    // button pressed; the PDF + filing take a few seconds server-side and the
    // page moves on to the next document meanwhile. A failure puts it back.
    // Requests are queued one behind another so two quick signatures never
    // race each other on the engagement row.
    const signedName = name.trim();
    setOptimistic((o) => ({ ...o, [type]: { signedName, signedAt: new Date().toISOString() } }));
    setChecked(false);
    setOpenType(data.instruments.find((i) => !i.signed && !optimistic[i.type] && i.type !== type && !i.deferred)?.type ?? null);
    const run = async () => {
      const t = await token();
      if (!t) throw new Error("no session");
      const res = await fetch(`/api/dfy/engagements/${engagementId}/sign`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ type, signedName, accepted: true }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Couldn't sign. Try again.");
    };
    signQueue.current = signQueue.current.then(run).then(
      () => refresh(),
      (err: unknown) => {
        setOptimistic((o) => { const n = { ...o }; delete n[type]; return n; });
        setOpenType(type);
        setError(err instanceof Error ? err.message : "Couldn't sign. Try again.");
      },
    );
  }

  if (!data) {
    return error ? <div className="mx-auto max-w-3xl p-6"><p className="text-sm text-gray-500">{error}</p></div> : <CubeLoaderBuilding />;
  }
  const e = data.engagement;
  const total = data.instruments.length;
  const done = data.instruments.filter((i) => i.signed || optimistic[i.type]).length;
  const composed = data.composition.groundSelected && data.composition.letterAdopted;

  const closed = e.status === "terminated" || e.status === "converted" || e.status === "completed";
  const stateLine =
    e.status === "active" ? "we're on it"
    : e.status === "signed" ? "all signed"
    : closed ? (e.status === "completed" ? "complete" : "ended")
    : done > 0 ? "in progress" : "ready to sign";

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      {/* ── header ── */}
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-600">Done for you</div>
        <h1 className="mt-1.5 text-[26px] font-bold leading-tight tracking-tight text-gray-900">Your appeal, handled.</h1>
        <p className="mt-2.5 max-w-2xl text-[14.5px] leading-relaxed text-gray-600">
          To have us submit your appeal, follow up, and track its deadlines as your authorized representative, read and sign the {total} documents below. Nothing happens until you do. You can always file on your own at no cost using Candid&apos;s free tools.
        </p>
        <p className="mt-3 text-xs"><Link href={`/claim?claim=${e.claimId}`} className="font-medium text-blue-700 hover:underline">← Back to your claim</Link></p>
      </div>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {data.screened && !data.screened.eligible && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <b>We can&apos;t take this one on.</b> {data.screened.declineReason ?? ""} Your appeal and every free tool stay yours.
        </div>
      )}

      {/* ── where you are ── */}
      {!closed && (
        <ol className="grid grid-cols-4 gap-2 text-[11.5px] font-semibold">
          {(["Request sent", "Sign your documents", "We confirm", "We start"] as const).map((label, i) => {
            const current = e.status === "active" ? 3 : e.status === "signed" ? 2 : 1;
            const state = i < current ? "done" : i === current ? "now" : "later";
            return (
              <li key={label} className={`rounded-xl border px-3 py-2 ${state === "done" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : state === "now" ? "border-blue-300 bg-blue-50 text-blue-800 ring-2 ring-blue-100" : "border-gray-200 bg-white text-gray-400"}`}>
                <span className="mr-1.5 text-[10px] uppercase tracking-wide opacity-70">{state === "done" ? "✓" : `${i + 1}`}</span>{label}{state === "now" ? " ←" : ""}
              </li>
            );
          })}
        </ol>
      )}

      {/* ── progress ── */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-[15px] font-semibold text-gray-900">{done} of {total} documents signed</div>
          <div className={`text-[12px] font-semibold uppercase tracking-wide ${e.status === "active" ? "text-emerald-700" : closed ? "text-gray-500" : "text-blue-700"}`}>{stateLine}</div>
        </div>
        <div className="mt-3 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}>
          {data.instruments.map((i) => (
            <div key={i.type} className={`h-1.5 rounded-full ${i.signed || optimistic[i.type] ? "bg-blue-600" : "bg-gray-200"}`} />
          ))}
        </div>
        <p className="mt-3 text-[13.5px] leading-relaxed text-gray-600">
          {e.status === "eligibility_pending" && !data.screened && "Sign the documents below now. We're confirming we can take this one on and will start the moment it clears."}
          {e.status === "eligibility_pending" && data.screened?.eligible && "You're approved. Sign the remaining documents and we start."}
          {e.status === "signed" && !data.screened && "All signed. We're confirming we can take this one on, then we start."}
          {e.status === "signed" && data.screened?.eligible && !composed && "We start as soon as you've built and adopted your appeal in the free tool. That part is yours."}
          {e.status === "signed" && composed && data.payment.required && `One step left: the $${(data.payment.feeCents / 100).toFixed(2)} fee.`}
          {e.status === "active" && <>Every step we take shows on your claim timeline as &quot;Done by Candid&quot;. Any decision stays yours.{data.phase && <span className="text-gray-500"> Current phase: {data.phase}.</span>}</>}
          {closed && (e.status === "completed" ? "This engagement is complete." : "This engagement has ended.")}
        </p>
      </section>

      {data.payment.required && engagementId && (
        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-semibold text-gray-900">The fee</h2>
          <p className="mt-1 text-sm text-gray-600">${(data.payment.feeCents / 100).toFixed(2)}, one time, for this claim only. The appeal itself is free. This fee pays for our preparation and submission work.</p>
          <div className="mt-3"><PayStep engagementId={engagementId} token={token} onPaid={() => setTimeout(refresh, 1500)} /></div>
        </section>
      )}

      {/* ── the documents ── */}
      <ol className="space-y-3">
        {data.instruments.map((inst, idx) => {
          const open = openType === inst.type;
          const sig = inst.signed ?? optimistic[inst.type] ?? null;
          const signable = !sig && data.canSign && !inst.deferred;
          const pill = sig
            ? { cls: "bg-emerald-50 text-emerald-700 ring-emerald-200", text: `Signed ${fmt(sig.signedAt)}` }
            : inst.deferred && data.canSign
              ? { cls: "bg-amber-50 text-amber-800 ring-amber-200", text: "Waiting for your representative" }
              : data.canSign
                ? { cls: "bg-blue-50 text-blue-700 ring-blue-200", text: "Ready to sign" }
                : { cls: "bg-gray-100 text-gray-500 ring-gray-200", text: "Closed" };
          return (
            <li key={inst.type} className={`overflow-hidden rounded-2xl border bg-white transition-shadow ${open ? "border-blue-200 shadow-[0_8px_24px_-12px_rgba(37,99,235,0.35)]" : "border-gray-200 shadow-[0_1px_2px_rgba(16,24,40,0.04)]"}`}>
              <button type="button" onClick={() => setOpenType(open ? null : inst.type)} className="flex w-full items-center gap-4 p-4 text-left sm:p-5">
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-bold ${sig ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600"}`}>
                  {sig ? (
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                  ) : idx + 1}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-semibold text-gray-900">{inst.title}</div>
                  <div className="mt-0.5 text-[12px] text-gray-500">Document {idx + 1} of {total} · version {inst.version} · effective {inst.effectiveDate}</div>
                </div>
                <span className={`hidden shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-semibold ring-1 ring-inset sm:inline-block ${pill.cls}`}>{pill.text}</span>
                <svg viewBox="0 0 24 24" className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
              </button>
              <span className={`mx-4 -mt-1 mb-3 inline-block rounded-full px-2.5 py-1 text-[11.5px] font-semibold ring-1 ring-inset sm:hidden ${pill.cls}`}>{pill.text}</span>

              {open && (
                <div className="border-t border-gray-100">
                  {/* the document itself, in its own scroll frame */}
                  <div className="max-h-[440px] overflow-y-auto bg-gray-50/60 px-5 py-5 sm:px-7">
                    <LegalText text={inst.text} variant={inst.authorizationForm ? "authorization" : "default"} />
                  </div>

                  {/* the signature panel */}
                  <div className="border-t border-gray-100 p-5 sm:p-6">
                    {sig ? (
                      <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-5">
                        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-700">Signed electronically{!inst.signed && <CubeLoaderBuilding variant="inline" size={14} />}</div>
                        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
                          <div className="min-w-0">
                            <div className="truncate pb-1 text-[30px] leading-none text-gray-900" style={{ fontFamily: SIGNATURE_FONT }}>{sig.signedName}</div>
                            <div className="border-t border-gray-400 pt-1.5 text-[12px] text-gray-500">{sig.signedName} · {new Date(sig.signedAt).toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</div>
                          </div>
                          {inst.pdfUrl && (
                            <a href={inst.pdfUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-xl border border-gray-300 bg-white px-3.5 py-2 text-[13px] font-semibold text-gray-800 hover:bg-gray-50">
                              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                              View signed PDF
                            </a>
                          )}
                        </div>
                      </div>
                    ) : inst.deferred && data.canSign ? (
                      <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50/60 p-4 text-[13.5px] text-amber-900">
                        <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
                        <span>{inst.deferred}</span>
                      </div>
                    ) : signable ? (
                      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">Your signature</div>
                        <div className="mt-3 rounded-xl border border-dashed border-gray-300 bg-gray-50 px-5 pb-3 pt-6">
                          <div className={`min-h-[44px] truncate text-[32px] leading-none ${name.trim() ? "text-gray-900" : "text-gray-300"}`} style={{ fontFamily: SIGNATURE_FONT }}>{name.trim() || "Your name"}</div>
                          <div className="mt-2 flex items-center justify-between border-t border-gray-400 pt-1.5 text-[11.5px] text-gray-500">
                            <span>Signed electronically</span>
                            <span>{new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</span>
                          </div>
                        </div>
                        <label className="mt-4 block text-[13px] font-medium text-gray-700">Type your full name to sign
                          <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Your full name" autoComplete="name" className="mt-1.5 block w-full rounded-xl border border-gray-300 px-3.5 py-2.5 text-[15px] text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100" />
                        </label>
                        <label className="mt-4 flex cursor-pointer items-start gap-3 text-[13.5px] leading-relaxed text-gray-700">
                          <input type="checkbox" checked={checked} onChange={(ev) => setChecked(ev.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                          <span>I&apos;ve read this {inst.title} in full and sign it electronically. I understand it is separate from the other documents on this page.</span>
                        </label>
                        <button disabled={!checked || name.trim().length < 2} onClick={() => void sign(inst.type)} className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-[15px] font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto">
                          Sign {inst.title}
                        </button>
                      </div>
                    ) : (
                      <p className="text-sm text-gray-500">Signing is closed on this engagement.</p>
                    )}

                    {inst.type !== "health_data_upload" && engagementId && (
                      <p className="mt-4 text-[12px] text-gray-500">
                        Plan wants a handwritten signature?{" "}
                        <a href={`/api/dfy/engagements/${engagementId}/instrument?type=${inst.type}`} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-700 hover:underline">Print this form</a>, sign it, and add the pages in <Link href="/upload" className="font-medium text-blue-700 hover:underline">Upload</Link>. Your signature here stays on file either way.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {["eligibility_pending", "signed", "active"].includes(e.status) && (
        <div className="rounded-2xl border border-gray-200 bg-white p-5 text-sm">
          <div className="font-semibold text-gray-900">Changed your mind?</div>
          <p className="mt-1 leading-relaxed text-gray-600">End this engagement any time. Cancel within three business days of signing and any fee is refunded in full. After that, your fee agreement&apos;s refund terms apply. Every free Candid tool stays yours.</p>
          <button onClick={() => void cancel()} className="mt-3 rounded-xl border border-gray-300 bg-white px-3.5 py-2 text-[13px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">End this engagement</button>
        </div>
      )}
      <p className="text-xs text-gray-400">This product is not a substitute for the advice of an attorney.</p>
    </div>
  );
}
