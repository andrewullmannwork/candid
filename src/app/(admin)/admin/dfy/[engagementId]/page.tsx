/**
 * /admin/dfy/[engagementId] — Screen B: the matter view (S330, mock v2).
 *
 * "This is the member's rail — exactly what they see, muted." The steps ARE
 * the projector's output composed by the SAME composeRail the claim page uses,
 * rendered with the SAME RailStep primitive; the operator's controls attach
 * beneath the steps as slots. No parallel rail, no second composition. The
 * member's own interactive handlers are deliberately absent here — an operator
 * never performs a member act.
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { RailStep } from "@/components/claims/CaseRail";
import { composeRail, type RailLetterGroup, type RailStepModel } from "@/lib/case/rail-steps";
import type { ProjectedLetterStep, ProjectedRegulatorComplaint } from "@/lib/case/timeline-projector";
import { EMPTY_PROJECTED_REGULATOR } from "@/lib/case/timeline-projector";

interface UserDisplay { userId: string; displayName: string | null; email: string | null }
interface Gate { id: string; label: string; pass: boolean; reason: string | null }
interface DfyEvent { kind: string; occurredAt: string; disputeId: string | null; payload: Record<string, unknown> }
interface MatterPayload {
  matter: {
    engagement: { id: string; claim_id: string; status: string; payer: string; sponsor_ref: string | null; operator_user_id: string | null; consent_event_ids: Record<string, unknown>; intake: { decision?: { eligible: boolean; gates: Gate[]; declineReason: string | null } }; metadata: { payment?: { status?: string; amountCents?: number; refund?: { id: string } } } };
    member: UserDisplay & { state: string | null };
    holder: UserDisplay | null;
    composition: { groundSelected: boolean; letterAdopted: boolean };
    insurerLetter: { disputeId: string; letterType: string; status: string; governingDeadlineDate: string | null; denialNoticeDate: string | null } | null;
    runwayBusinessDays: number | null;
    events: DfyEvent[];
    phase: string;
  };
  timeline: { letters: ProjectedLetterStep[]; regulator: ProjectedRegulatorComplaint; insurerNameByDispute: Record<string, string>; providerName: string | null } | null;
  canAct: boolean;
  isHolder: boolean;
  config: { refusalRunwayBusinessDays: number };
  /** The forums the member could file with (the SAME router the rail uses) — the packet's cover names the one the operator picks. */
  forums: Array<{ id: string; short: string; menuLabel: string; role: string }>;
  insurer: { id: string; name: string } | null;
}

const ACT_LABEL: Record<string, string> = {
  dfy_designation_submitted: "Designation submitted",
  dfy_designation_acknowledged: "Designation acknowledged",
  dfy_document_requested: "Documents requested",
  dfy_appeal_transmitted: "Appeal transmitted",
  dfy_status_called: "Status call logged",
  dfy_response_recorded: "Response recorded",
  dfy_offer_relayed: "Offer relayed",
  dfy_packet_prepared: "Packet prepared",
  dfy_determination_recorded: "Determination recorded",
  dfy_audit_logged: "Audit review logged",
  dfy_claimed: "Claimed",
  dfy_released: "Released",
  dfy_engagement_created: "Engagement opened",
  dfy_engagement_screened: "Screened",
  dfy_engagement_activated: "Activated",
  dfy_engagement_closed: "Closed",
};

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function stepText(s: RailStepModel): { title: string; sub: string | null; done: boolean; locked: boolean } {
  switch (s.kind) {
    case "wait-active": return { title: s.title, sub: s.sub, done: false, locked: false };
    case "next-move": return { title: s.title, sub: s.sub, done: false, locked: false };
    case "wait-receipt": return { title: s.title, sub: s.receipt, done: true, locked: false };
    case "send-receipt": return { title: s.title, sub: s.receipt, done: true, locked: false };
    case "send-draft": return { title: s.title, sub: null, done: false, locked: false };
    case "guide-step": return { title: s.title, sub: s.body, done: s.state === "done", locked: false };
    default: {
      const g = s as { title?: string; sub?: string | null };
      return { title: g.title ?? s.kind, sub: g.sub ?? null, done: false, locked: false };
    }
  }
}

export default function DfyMatterPage({ params }: { params: Promise<{ engagementId: string }> }) {
  const { user } = useAuth();
  const [engagementId, setEngagementId] = useState<string | null>(null);
  const [data, setData] = useState<MatterPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [callDate, setCallDate] = useState("");
  const [callRef, setCallRef] = useState("");
  const [tracking, setTracking] = useState("");
  const [offerDollars, setOfferDollars] = useState("");
  const [determination, setDetermination] = useState<"approved" | "denied" | "partial">("denied");
  const [closeReason, setCloseReason] = useState("");
  const [forumId, setForumId] = useState("");
  const [chan, setChan] = useState({ submissionChannel: "", wetInkRequired: false, designationFormRequired: false, formUrl: "", faxNumber: "", note: "" });

  const token = useCallback(async () => (user ? user.firebaseUser.getIdToken() : null), [user]);
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(async () => { setReloadKey((k) => k + 1); }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    async function load() {
      const { engagementId: id } = await params;
      const t = await user!.firebaseUser.getIdToken();
      const res = await fetch(`/api/admin/dfy/engagements/${id}`, { headers: { Authorization: `Bearer ${t}` } });
      if (cancelled) return;
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error || `Load failed (${res.status})`); setEngagementId(id); return; }
      const json = (await res.json()) as MatterPayload;
      if (cancelled) return;
      setEngagementId(id);
      setError(null);
      setData(json);
    }
    void load();
    return () => { cancelled = true; };
  }, [user, params, reloadKey]);

  async function post(path: string, body: unknown) {
    const t = await token();
    if (!t || !engagementId) return;
    setBusy(true);
    const res = await fetch(`/api/admin/dfy/engagements/${engagementId}/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: JSON.stringify(body),
    });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error || `Failed (${res.status})`);
    else setError(null);
    setBusy(false);
    await refresh();
  }
  const act = (kind: string, extra: Record<string, unknown> = {}, disputeId: string | null = null) => post("actions", { kind, disputeId, ...extra });

  const groups: RailLetterGroup[] = useMemo(() => {
    if (!data?.timeline) return [];
    return composeRail({
      letters: data.timeline.letters,
      regulator: data.timeline.regulator ?? EMPTY_PROJECTED_REGULATOR,
      offers: [],
      firstNumber: 1,
      insurerNameByDispute: data.timeline.insurerNameByDispute ?? {},
      providerName: data.timeline.providerName ?? null,
      forumMenu: null,
      now: new Date(),
    }).groups;
  }, [data]);

  if (!data) {
    return <div className="max-w-3xl"><Link href="/admin/dfy" className="text-sm text-blue-700 hover:underline">← queue</Link><p className="mt-3 text-sm text-gray-500">{error ?? "Loading…"}</p></div>;
  }
  const { matter, canAct, isHolder } = data;
  const e = matter.engagement;
  const composed = matter.composition.groundSelected && matter.composition.letterAdopted;
  const eventsFor = (disputeId: string | null, kinds: string[]) => matter.events.filter((ev) => kinds.includes(ev.kind) && (disputeId === null || ev.disputeId === disputeId || ev.disputeId === null));
  const doneBy = (disputeId: string | null, kinds: string[]) => eventsFor(disputeId, kinds).map((ev) => (
    <span key={`${ev.kind}-${ev.occurredAt}`} className="ml-1 inline-block rounded-md border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10.5px] font-bold text-violet-700">
      {ACT_LABEL[ev.kind] ?? ev.kind} · Done by Candid · {fmt(ev.occurredAt)}
    </span>
  ));
  const btn = "rounded-lg bg-violet-700 px-2.5 py-1 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400";
  const sec = "rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-[12px] font-semibold text-gray-700 disabled:opacity-50";
  const inp = "rounded-md border border-gray-300 px-2 py-1 text-[12px] w-32";
  const consents = Object.keys(e.consent_event_ids ?? {}).length;
  const runwayRed = matter.runwayBusinessDays !== null && matter.runwayBusinessDays < data.config.refusalRunwayBusinessDays;

  /** Operator controls attached beneath a member step, by the step's kind. */
  function slot(s: RailStepModel, disputeId: string | null) {
    if (s.kind === "send-draft") {
      return (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button className={btn} disabled={!canAct || busy} onClick={() => void act("dfy_designation_submitted", { channel: "issuer_form" }, disputeId)}>Designation submitted</button>
          <button className={btn} disabled={!canAct || busy} onClick={() => void act("dfy_designation_acknowledged", {}, disputeId)}>Designation acknowledged</button>
          <button className={btn} disabled={!canAct || busy} onClick={() => void act("dfy_document_requested", {}, disputeId)}>Documents requested</button>
          <input className={inp} placeholder="tracking #" value={tracking} onChange={(ev) => setTracking(ev.target.value)} />
          <button className={btn} disabled={!canAct || busy || !composed} title={composed ? "Transmit the member's own composed appeal, verbatim" : "Enables only when the member's own composition events exist"} onClick={() => void act("dfy_appeal_transmitted", tracking ? { trackingRef: tracking } : {}, disputeId)}>Transmit appeal</button>
          <span className="text-[11.5px] text-gray-500">{composed ? "member composed ✓" : "waiting on member — no composition on record"}</span>
          {doneBy(disputeId, ["dfy_designation_submitted", "dfy_designation_acknowledged", "dfy_document_requested", "dfy_appeal_transmitted"])}
        </div>
      );
    }
    if (s.kind === "send-receipt" || s.kind === "wait-active") {
      return (
        <div className="mt-2 space-y-2">
          <div className="rounded-lg border border-gray-300 bg-white p-2.5 text-[12px]">
            <div className="text-[10.5px] font-extrabold uppercase tracking-wide text-violet-700">The one script — status call · v1</div>
            <p className="mt-1 italic text-gray-700">&quot;I&apos;m calling as the authorized representative for [member] regarding appeal [reference]. I&apos;m confirming receipt and the decision due date. I&apos;m not calling to discuss the merits.&quot;</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <input className={inp} type="date" value={callDate} onChange={(ev) => setCallDate(ev.target.value)} />
              <input className={inp} placeholder="reference #" value={callRef} onChange={(ev) => setCallRef(ev.target.value)} />
              <button className={btn} disabled={!canAct || busy} onClick={() => void act("dfy_status_called", { ...(callDate ? { calledAt: callDate } : {}), ...(callRef ? { reference: callRef } : {}) }, disputeId)}>Log status call</button>
              <span className="text-[11px] text-gray-500">Contemporaneous notes only — no recordings.</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className={btn} disabled={!canAct || busy} onClick={() => void act("dfy_response_recorded", {}, disputeId)}>Record response</button>
            <input className={inp} placeholder="offer $ (bare number)" value={offerDollars} onChange={(ev) => setOfferDollars(ev.target.value)} />
            <button className={btn} disabled={!canAct || busy || !/^\d+(\.\d{1,2})?$/.test(offerDollars)} onClick={() => void act("dfy_offer_relayed", { amountCents: Math.round(Number(offerDollars) * 100) }, disputeId)}>Relay offer</button>
            {doneBy(disputeId, ["dfy_status_called", "dfy_response_recorded", "dfy_offer_relayed"])}
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800"><b>Notifies the member:</b> recording a response or offer here is logged as NEW FACTS the member reviews on their own surfaces. Nothing proceeds until they act. The operator never answers for them.</div>
        </div>
      );
    }
    if (s.kind === "next-move") {
      return (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select className="rounded-md border border-gray-300 bg-white px-2 py-1 text-[12px]" value={forumId} onChange={(ev) => setForumId(ev.target.value)}>
            <option value="">forum…</option>
            {(data?.forums ?? []).map((f) => <option key={f.id} value={f.id}>{f.menuLabel}</option>)}
          </select>
          <button className={btn} disabled={!canAct || busy || !forumId} onClick={() => void act("dfy_packet_prepared", { forumId }, disputeId)}>Prepare packet</button>
          <span className="text-[11.5px] text-gray-600"><b>The MEMBER files it</b> at the state level: Candid prepares the finished DMHC packet; the member signs and submits it.</span>
          {doneBy(disputeId, ["dfy_packet_prepared"])}
        </div>
      );
    }
    return null;
  }

  return (
    <div className="max-w-4xl space-y-5">
      <Link href="/admin/dfy" className="text-sm text-blue-700 hover:underline">← queue</Link>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="text-[15px] font-semibold text-gray-900">{matter.member.displayName || matter.member.email || "member"}</span>
        <span className="text-gray-500">· claim {e.claim_id.slice(0, 8)}… · {matter.member.state ?? "state —"}</span>
        <span className="rounded-lg border border-gray-300 bg-gray-50 px-2 py-0.5 font-semibold text-gray-700">engagement: {e.status}</span>
        <span className="rounded-lg border border-violet-200 bg-violet-50 px-2 py-0.5 font-semibold text-violet-700">{e.operator_user_id ? (isHolder ? "claimed by you" : `held by ${matter.holder?.displayName || matter.holder?.email || "another operator"}`) : "unclaimed"}</span>
        <span className="rounded-lg border border-gray-300 bg-gray-50 px-2 py-0.5 font-semibold text-gray-700">lane: insurer · {e.payer}{e.sponsor_ref ? ` · ${e.sponsor_ref}` : ""}</span>
        <span className="rounded-lg border border-gray-300 bg-gray-50 px-2 py-0.5 font-semibold text-gray-700">paper: {consents}/5 consents</span>
        <span className={`rounded-lg border px-2 py-0.5 font-semibold ${runwayRed ? "border-red-200 bg-red-50 text-red-700" : "border-gray-300 bg-gray-50 text-gray-700"}`}>{matter.runwayBusinessDays === null ? "no dated window" : `${matter.runwayBusinessDays} business days runway`}</span>
        <span className="text-gray-600">{matter.phase}</span>
      </div>
      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700"><b>Execution only.</b> Never select the ground · never interpret the plan · never advise on an offer. A member question about what to argue → decline template + their own surfaces.</div>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {e.intake?.decision && (
        <div className="flex flex-wrap gap-1">
          {e.intake.decision.gates.map((g) => (
            <span key={g.id} title={g.reason ?? g.label} className={`rounded-md border px-1.5 py-0.5 text-[10.5px] font-bold ${g.pass ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}`}>{g.id} {g.label}</span>
          ))}
        </div>
      )}

      <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
        <div className="mb-2 text-[12px] text-gray-500">This is the member&apos;s rail — exactly what they see, muted. Operator controls attach to the steps.</div>
        <div className="mb-3 space-y-1 text-[12.5px]">
          <div className={matter.composition.groundSelected ? "text-emerald-700" : "text-gray-500"}>{matter.composition.groundSelected ? "✓" : "○"} Grounds selected by member</div>
          <div className={matter.composition.letterAdopted ? "text-emerald-700" : "text-gray-500"}>{matter.composition.letterAdopted ? "✓" : "○"} Appeal letter adopted by member</div>
        </div>
        {groups.length === 0 ? (
          <p className="text-sm text-gray-500">No letters on this claim yet — the member composes in the free tool first.</p>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="mt-4 first:mt-0 opacity-95">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{g.eyebrow} · {g.title}</div>
              {g.steps.map((s, i) => {
                const t = stepText(s);
                return (
                  <RailStep key={s.key} n={s.badge} title={t.title} sub={t.sub} done={t.done} locked={t.locked} last={i === g.steps.length - 1} dataLetter={g.disputeId}>
                    {slot(s, g.disputeId)}
                  </RailStep>
                );
              })}
            </section>
          ))
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-gray-300 pt-3 text-[12.5px]">
        <span className="text-gray-500">Matter-level:</span>
        <select className="rounded-md border border-gray-300 bg-white px-2 py-1 text-[12px]" value={determination} onChange={(ev) => setDetermination(ev.target.value as "approved" | "denied" | "partial")}><option value="approved">approved</option><option value="denied">denied</option><option value="partial">partial</option></select>
        <button className={btn} disabled={!canAct || busy || !matter.insurerLetter} onClick={() => void act("dfy_determination_recorded", { determination }, matter.insurerLetter?.disputeId ?? null)}>Record determination</button>
        <button className={sec} disabled={!canAct || busy} onClick={() => void act("dfy_audit_logged", {})}>Log audit review</button>
        {e.status === "signed" && isHolder && <button className={btn} disabled={busy || !composed} onClick={() => void post("transition", { to: "active" })}>Activate</button>}
        {["active", "signed", "eligibility_pending"].includes(e.status) && (isHolder || !e.operator_user_id) && (
          <>
            <input className={inp} placeholder="reason" value={closeReason} onChange={(ev) => setCloseReason(ev.target.value)} />
            {e.status === "active" && <button className={sec} disabled={busy} onClick={() => void post("transition", { to: "completed", reason: closeReason })}>Complete</button>}
            {e.status === "active" && <button className={sec} disabled={busy} onClick={() => void post("transition", { to: "converted", reason: closeReason })}>Convert</button>}
            <button className={sec} disabled={busy} onClick={() => void post("transition", { to: "terminated", reason: closeReason })}>Terminate</button>
          </>
        )}
        {["terminated", "converted", "completed"].includes(e.status) && e.metadata?.payment?.status === "succeeded" && !e.metadata.payment.refund && (
          <button className={sec} disabled={busy} onClick={() => void post("refund", { basis: e.status === "converted" ? "converted_before_transmit" : "operator_discretion" })}>Refund ${((e.metadata.payment.amountCents ?? 0) / 100).toFixed(2)}</button>
        )}
        <span className="text-[11.5px] text-gray-500">every button on this page writes a tagged operator event to the same timeline the member sees</span>
      </div>

      <section className="rounded-2xl border border-gray-200 bg-white p-4">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-gray-500">What this plan actually required — feeds the insurer-intelligence queue</h2>
        <p className="mt-1 text-[12px] text-gray-500">{data.insurer ? `Insurer: ${data.insurer.name}.` : "No insurer on the pinned plan."} A verified submission channel, a designation-form requirement, or a corrected appeals address goes through the same queues member corrections use — never a new pipeline.</p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
          <select className="rounded-md border border-gray-300 bg-white px-2 py-1" value={chan.submissionChannel} onChange={(ev) => setChan({ ...chan, submissionChannel: ev.target.value })}><option value="">channel…</option><option value="mail">mail</option><option value="fax">fax</option><option value="portal">portal</option><option value="email">email</option></select>
          <label className="flex items-center gap-1"><input type="checkbox" checked={chan.designationFormRequired} onChange={(ev) => setChan({ ...chan, designationFormRequired: ev.target.checked })} /> plan&apos;s own designation form required</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={chan.wetInkRequired} onChange={(ev) => setChan({ ...chan, wetInkRequired: ev.target.checked })} /> wet-ink signature required</label>
          <input className={inp} placeholder="form URL" value={chan.formUrl} onChange={(ev) => setChan({ ...chan, formUrl: ev.target.value })} />
          <input className={inp} placeholder="fax #" value={chan.faxNumber} onChange={(ev) => setChan({ ...chan, faxNumber: ev.target.value })} />
          <input className="rounded-md border border-gray-300 px-2 py-1 text-[12px] w-64" placeholder="note (facts only)" value={chan.note} onChange={(ev) => setChan({ ...chan, note: ev.target.value })} />
          <button className={btn} disabled={!canAct || busy || !data.insurer} onClick={() => void act("dfy_channel_observed", { insurerId: data.insurer?.id, ...chan })}>Record observation</button>
        </div>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-4">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-gray-500">Operator log</h2>
        {matter.events.length === 0 ? <p className="mt-2 text-sm text-gray-500">No operator events yet.</p> : (
          <ul className="mt-2 space-y-1 text-[12.5px]">
            {matter.events.map((ev) => (
              <li key={`${ev.kind}-${ev.occurredAt}`} className="flex flex-wrap gap-2 text-gray-700">
                <span className="w-16 text-gray-400">{fmt(ev.occurredAt)}</span>
                <span className="font-medium">{ACT_LABEL[ev.kind] ?? ev.kind}</span>
                {ev.disputeId && <span className="text-gray-400">letter {ev.disputeId.slice(0, 8)}…</span>}
                {Object.entries(ev.payload).filter(([k]) => !["engagementId", "operatorUserId", "role"].includes(k)).map(([k, v]) => <span key={k} className="text-gray-500">{k}: {String(v)}</span>)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
