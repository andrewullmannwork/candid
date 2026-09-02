/**
 * /admin/dfy — Screen A: the operator's matter queue + intake screening (S330,
 * built to the approved mock v2: plans/mocks/s325-d8-operator-surface-mock.html).
 *
 * Every read/write goes through the operator API under the engagement grant.
 * A matter must be CLAIMED before anyone can act on it; the concurrent cap is
 * per operator (config). The intake section is the legal front door: Gates
 * 0–6 + the runway threshold, fail-closed, every applicant screened.
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

interface UserDisplay { userId: string; displayName: string | null; email: string | null }
interface Gate { id: string; label: string; pass: boolean; reason: string | null }
interface Matter {
  engagement: {
    id: string; claim_id: string; status: string; payer: string; sponsor_ref: string | null;
    operator_user_id: string | null; created_at: string;
    intake: { decision?: { eligible: boolean; gates: Gate[]; declineReason: string | null } | null; accepted?: { at: string }; declined?: { at: string; reason: string; memberReason: string } };
    consent_event_ids: Record<string, unknown>;
    metadata?: { closedReason?: string | null; compositionAtApply?: boolean };
  };
  paperwork?: {
    plan: { id: string; planName: string | null; insurerName: string | null; planType: string | null; state: string | null; employerName: string | null; groupNumber: string | null; classification: Record<string, unknown> | null } | null;
    claim: { claimNumber: string | null; provider: string | null; insurer: string | null; dateOfService: string | null; totalBilled: number | null; patientResponsibility: number | null; inCollections: boolean };
    grounds: string[];
    documents: Array<{ id: string; fileName: string | null; docType: string | null; classifiedType: string | null; createdAt: string | null }>;
  };
  insurerLetter?: { denialNoticeDate: string | null; letterType: string; status: string; governingDeadlineDate: string | null } | null;
  member: UserDisplay & { state: string | null };
  holder: UserDisplay | null;
  composition: { groundSelected: boolean; letterAdopted: boolean };
  runwayBusinessDays: number | null;
  lastAct: { kind: string; occurredAt: string } | null;
  phase: string;
}
interface Sponsor { id: string; code: string; name: string; contact_email: string | null; agreement_signed_at: string | null; active: boolean }
interface SponsorReport { code: string; name: string; total: number; suppressed: boolean; k: number; byStatus: Record<string, number> | null; byDetermination: Record<string, number> | null }
interface AccessReview { operators: Array<{ userId: string; email: string; displayName: string | null; isAdmin: boolean }>; lastReview: { at: string | null; by: string | null }; ageDays: number | null; stale: boolean }
interface QueuePayload {
  operator: { userId: string; email: string; role: string; held: number; cap: number; ip: string | null };
  config: { refusalRunwayBusinessDays: number; ipAllowlistEnforced: boolean; ipAllowlistSize: number; marketingGateVerifiedOn: string | null };
  matters: Matter[];
  applicants: Matter[];
}

const STATUS_TONE: Record<string, string> = {
  active: "text-emerald-700 bg-emerald-50 border-emerald-200",
  signed: "text-amber-800 bg-amber-50 border-amber-200",
  eligibility_pending: "text-gray-600 bg-gray-50 border-gray-300",
  completed: "text-blue-700 bg-blue-50 border-blue-200",
  converted: "text-violet-700 bg-violet-50 border-violet-200",
  terminated: "text-red-700 bg-red-50 border-red-200",
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`inline-block rounded-lg border px-2 py-0.5 text-[11.5px] font-semibold ${tone}`}>{children}</span>;
}

function who(u: UserDisplay | null): string {
  if (!u) return "unclaimed";
  return u.displayName || u.email || u.userId.slice(0, 8);
}

export default function DfyQueuePage() {
  const { user } = useAuth();
  const [data, setData] = useState<QueuePayload | null>(null);
  const [dark, setDark] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState<Record<string, string>>({});
  // Invite form
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteClaim, setInviteClaim] = useState("");
  const [invitePayer, setInvitePayer] = useState<"member_paid" | "sponsor_paid">("member_paid");
  const [inviteSponsor, setInviteSponsor] = useState("");
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);
  // Screening answers per applicant
  const [answers, setAnswers] = useState<Record<string, { planSponsorType: string; secondaryCoverageCdi: string; governmentProgram: string; memberAskedWhatToArgue: string; part2Records: string }>>({});
  // Admin-only sections (sponsors + the weekly access review) — the routes refuse non-admins; the UI simply hides on 403.
  const [sponsors, setSponsors] = useState<Sponsor[] | null>(null);
  const [sponsorForm, setSponsorForm] = useState({ code: "", name: "", contactEmail: "", agreementSignedAt: "" });
  const [report, setReport] = useState<SponsorReport | null>(null);
  const [access, setAccess] = useState<AccessReview | null>(null);

  const token = useCallback(async () => (user ? user.firebaseUser.getIdToken() : null), [user]);
  // Reload = bump the key; the load itself lives in the effect body (the admin
  // layout's own pattern — no setState invoked synchronously from an effect).
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(async () => { setReloadKey((k) => k + 1); }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    async function load() {
      const t = await user!.firebaseUser.getIdToken();
      // admin-only panels load beside the queue; a 403 just leaves them hidden
      void fetch("/api/admin/dfy/sponsors", { headers: { Authorization: `Bearer ${t}` } }).then(async (r) => { if (r.ok && !cancelled) setSponsors(((await r.json()) as { sponsors: Sponsor[] }).sponsors); });
      void fetch("/api/admin/dfy/access-review", { headers: { Authorization: `Bearer ${t}` } }).then(async (r) => { if (r.ok && !cancelled) setAccess((await r.json()) as AccessReview); });
      const res = await fetch("/api/admin/dfy/queue", { headers: { Authorization: `Bearer ${t}` } });
      if (cancelled) return;
      if (res.status === 404) { setDark(true); setData(null); return; }
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error || `Queue failed (${res.status})`); return; }
      const json = (await res.json()) as QueuePayload;
      if (cancelled) return;
      setError(null);
      setDark(false);
      setData(json);
    }
    void load();
    return () => { cancelled = true; };
  }, [user, reloadKey]);

  async function post(path: string, body?: unknown): Promise<{ ok: boolean; json: Record<string, unknown> }> {
    const t = await token();
    if (!t) return { ok: false, json: { error: "not signed in" } };
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, json };
  }

  async function claim(id: string) {
    setBusy(id);
    const r = await post(`/api/admin/dfy/engagements/${id}/claim`);
    if (!r.ok) setError(String(r.json.error ?? "Claim failed"));
    setBusy(null);
    await refresh();
  }
  async function release(id: string) {
    setBusy(id);
    const r = await post(`/api/admin/dfy/engagements/${id}/release`);
    if (!r.ok) setError(String(r.json.error ?? "Release failed"));
    setBusy(null);
    await refresh();
  }
  async function screen(id: string, action: "evaluate" | "accept" | "decline" | "reopen" = "evaluate") {
    const a = answers[id] ?? { planSponsorType: "", secondaryCoverageCdi: "", governmentProgram: "", memberAskedWhatToArgue: "", part2Records: "" };
    const tri = (v: string) => (v === "yes" ? true : v === "no" ? false : null);
    setBusy(id);
    const r = await post(`/api/admin/dfy/engagements/${id}/screen`, {
      action,
      reason: action === "decline" ? (declineReason[id] ?? "") : undefined,
      planSponsorType: a.planSponsorType || null,
      secondaryCoverageCdi: tri(a.secondaryCoverageCdi),
      governmentProgram: tri(a.governmentProgram),
      memberAskedWhatToArgue: tri(a.memberAskedWhatToArgue),
      part2Records: tri(a.part2Records),
    });
    if (!r.ok) setError(String(r.json.error ?? "Screening failed"));
    else if (action === "decline") setNotice(r.json.emailed ? "Declined. The member was emailed their reason." : "Declined. The member could not be emailed (no address or mail is off).");
    else if (action === "reopen") setNotice("Reopened — it is back in intake.");
    else setNotice(null);
    setBusy(null);
    await refresh();
  }
  async function invite() {
    setInviteMsg(null);
    const r = await post("/api/admin/dfy/engagements", {
      memberEmail: inviteEmail.trim(),
      claimId: inviteClaim.trim(),
      payer: invitePayer,
      sponsorRef: invitePayer === "sponsor_paid" ? inviteSponsor.trim() : undefined,
    });
    setInviteMsg(r.ok ? "Engagement opened — it now sits in intake screening." : String(r.json.error ?? "Could not open the engagement"));
    if (r.ok) { setInviteEmail(""); setInviteClaim(""); setInviteSponsor(""); }
    await refresh();
  }

  if (dark) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-xl font-semibold text-gray-900">Do it for you</h1>
        <p className="mt-2 text-sm text-gray-600">This section is dark — the <code>dfy_operator_v1</code> flag is off.</p>
      </div>
    );
  }

  const cfg = data?.config;
  const runwayTone = (n: number | null) =>
    n === null ? "text-gray-400" : n < (cfg?.refusalRunwayBusinessDays ?? 10) ? "text-red-700 font-semibold" : "text-gray-800";

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Do it for you — operator queue</h1>
        <p className="mt-1 text-sm text-gray-500">
          Execution only. Never select the ground · never interpret the plan · never advise on an offer. A member question about what to argue → decline and point to their own surfaces.
        </p>
      </div>

      {data && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-violet-200 bg-violet-50 px-4 py-2.5 text-[12.5px] text-violet-800">
          <span><b>Operator session</b> · {data.operator.email} ({data.operator.role})</span>
          <span>IP {data.config.ipAllowlistEnforced ? `allowlisted (${data.config.ipAllowlistSize})` : "allowlist not enforced"} · config-backed</span>
          <span>hardened password ✓</span>
          {access && (
            <span className={access.stale ? "rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-800" : ""}>
              last access review: {access.lastReview.at ? `${new Date(access.lastReview.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · weekly` : "never"}{access.stale ? " — due" : ""}
              <button className="ml-2 rounded-md border border-violet-300 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-violet-800" onClick={() => void post("/api/admin/dfy/access-review").then(() => refresh())}>Log review ({access.operators.length} operator{access.operators.length === 1 ? "" : "s"})</button>
            </span>
          )}
          <span><b>Your load</b>: {data.operator.held} of {data.operator.cap} · per-operator cap, config <code>concurrent_cap</code></span>
          {!data.config.marketingGateVerifiedOn && (
            <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-800">Gate 6 unverified — every applicant is refused until <code>marketing_gate_verified_on</code> is set</span>
          )}
        </div>
      )}

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Matters</h2>
        {!data ? (
          <p className="mt-3 text-sm text-gray-500">Loading…</p>
        ) : data.matters.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">No matters yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500">
                  <th className="px-2 py-1.5">Member</th><th className="px-2 py-1.5">Assigned</th><th className="px-2 py-1.5">Engagement</th>
                  <th className="px-2 py-1.5">Phase</th><th className="px-2 py-1.5">Deadline runway</th><th className="px-2 py-1.5">Composition</th>
                  <th className="px-2 py-1.5">Last action</th><th className="px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {data.matters.map((m) => {
                  const e = m.engagement;
                  const mine = e.operator_user_id === data.operator.userId;
                  const live = ["signed", "active"].includes(e.status);
                  return (
                    <tr key={e.id} className="border-t border-gray-100 align-top">
                      <td className="px-2 py-2 font-medium text-gray-900">{who(m.member)}<div className="text-[11px] font-normal text-gray-400">{m.member.state ?? "state —"} · claim {e.claim_id.slice(0, 8)}…</div></td>
                      <td className="px-2 py-2">{e.operator_user_id ? <Pill tone={mine ? "text-violet-700 bg-violet-50 border-violet-200" : "text-gray-600 bg-gray-50 border-gray-300"}>{mine ? "you" : who(m.holder)}</Pill> : <span className="text-gray-400">unclaimed</span>}</td>
                      <td className="px-2 py-2"><Pill tone={STATUS_TONE[e.status] ?? STATUS_TONE.eligibility_pending}>{e.status}</Pill><div className="text-[11px] text-gray-400">{e.payer}{e.sponsor_ref ? ` · ${e.sponsor_ref}` : ""}</div></td>
                      <td className="px-2 py-2 text-gray-800">{m.phase}</td>
                      <td className={`px-2 py-2 ${runwayTone(m.runwayBusinessDays)}`}>{m.runwayBusinessDays === null ? "no dated window" : `${m.runwayBusinessDays} business days`}</td>
                      <td className="px-2 py-2">{m.composition.groundSelected && m.composition.letterAdopted ? <span className="text-emerald-700">✓ member composed</span> : <span className="text-red-700">⛔ waiting on member</span>}</td>
                      <td className="px-2 py-2 text-gray-600">{m.lastAct ? `${m.lastAct.kind.replace("dfy_", "").replace(/_/g, " ")} · ${fmtDate(m.lastAct.occurredAt)}` : "—"}</td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        {live && !e.operator_user_id && (
                          <button disabled={busy === e.id} onClick={() => void claim(e.id)} className="rounded-lg bg-violet-700 px-3 py-1 text-[12px] font-semibold text-white disabled:opacity-50">Claim</button>
                        )}
                        {live && mine && (
                          <button disabled={busy === e.id} onClick={() => void release(e.id)} className="ml-1 rounded-lg border border-gray-300 bg-white px-3 py-1 text-[12px] font-semibold text-gray-700 disabled:opacity-50">Release</button>
                        )}
                        <Link href={`/admin/dfy/${e.id}`} className="ml-2 text-[12px] font-semibold text-blue-700 hover:underline">Open →</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-[12px] text-gray-500">
          <b className="text-gray-700">Claiming.</b> A matter must be claimed before anyone can act on it. Claiming stamps you onto the engagement record and logs a claim event on the member&apos;s timeline; the route layer then only accepts actions on a matter from the operator who holds it. Release/hand-off is a logged event too.
        </p>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Intake — people who asked, not yet accepted</h2>
          <span className="text-[12px] text-gray-500">Execution only: paperwork, submission, deadlines. A member who asks us what to argue is declined, kindly, with the free tool intact.</span>
        </div>
        {notice && <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">{notice}</div>}
        {data && data.applicants.length === 0 && <p className="mt-3 text-sm text-gray-500">No applicants waiting.</p>}
        <div className="mt-3 space-y-4">
          {data?.applicants.map((m) => {
            const e = m.engagement;
            const a = answers[e.id] ?? { planSponsorType: "", secondaryCoverageCdi: "", governmentProgram: "", memberAskedWhatToArgue: "", part2Records: "" };
            const set = (k: keyof typeof a, v: string) => setAnswers((p) => ({ ...p, [e.id]: { ...a, [k]: v } }));
            const decision = e.intake?.decision ?? null;
            const pw = m.paperwork;
            const signed = Object.keys(e.consent_event_ids ?? {}).length;
            const grounds = (pw?.grounds ?? []).map((g) => g.replace(/_/g, " "));
            const govHint = /medicare|medicaid|medi-cal|tricare|\bva\b|veterans|champva/i.test(`${pw?.plan?.planType ?? ""} ${pw?.plan?.insurerName ?? ""} ${pw?.plan?.planName ?? ""}`);
            const cls = pw?.plan?.classification as { regulator?: string; coverageType?: string; fundingType?: string } | null | undefined;
            const sel = "mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[12.5px]";
            const money = (n: number | null) => (n === null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
            return (
              <div key={e.id} className="overflow-hidden rounded-2xl border border-gray-200">
                {/* who */}
                <div className="flex flex-wrap items-center justify-between gap-2 bg-gray-50 px-4 py-3">
                  <div>
                    <span className="text-[15px] font-semibold text-gray-900">{who(m.member)}</span>
                    <span className="ml-2 text-[12px] text-gray-500">{m.member.state ?? "state —"} · {e.payer.replace("_", " ")}{e.sponsor_ref ? ` · ${e.sponsor_ref}` : ""} · {e.operator_user_id ? `held by ${who(m.holder)}` : "applied, unclaimed"} · {fmtDate(e.created_at)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-[12px]">
                    <Pill tone={signed >= 5 ? "text-emerald-700 bg-emerald-50 border-emerald-200" : signed > 0 ? "text-amber-800 bg-amber-50 border-amber-200" : "text-gray-600 bg-white border-gray-300"}>{signed} of 5 signed</Pill>
                    <Pill tone={m.composition.groundSelected && m.composition.letterAdopted ? "text-emerald-700 bg-emerald-50 border-emerald-200" : "text-amber-800 bg-amber-50 border-amber-200"}>{m.composition.groundSelected && m.composition.letterAdopted ? "appeal composed" : "appeal not composed yet"}</Pill>
                    <span className={runwayTone(m.runwayBusinessDays)}>{m.runwayBusinessDays === null ? "Deadline: none on record" : `Deadline: ${m.runwayBusinessDays} business days`}</span>
                  </div>
                </div>

                {/* the paperwork the operator screens FROM */}
                <div className="grid gap-4 border-t border-gray-100 px-4 py-4 text-[12.5px] text-gray-700 md:grid-cols-3">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Plan (from their documents)</div>
                    {pw?.plan ? (
                      <ul className="mt-1 space-y-0.5">
                        <li className="font-medium text-gray-900">{pw.plan.planName ?? "plan name not parsed"}</li>
                        <li>{pw.plan.insurerName ?? "insurer —"} · {pw.plan.planType ?? "type —"}{pw.plan.state ? ` · ${pw.plan.state}` : ""}</li>
                        <li>Employer: {pw.plan.employerName ?? "not stated"} · Group: {pw.plan.groupNumber ?? "—"}</li>
                        <li>Regulator: {cls?.regulator ?? "not stated in documents"}{cls?.coverageType ? ` · ${String(cls.coverageType).replace(/_/g, " ")}` : ""}{cls?.fundingType ? ` · ${String(cls.fundingType).replace(/_/g, " ")}` : ""}</li>
                      </ul>
                    ) : <p className="mt-1 text-gray-500">No plan pinned to this claim.</p>}
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Claim + denial</div>
                    <ul className="mt-1 space-y-0.5">
                      <li className="font-medium text-gray-900">{pw?.claim.provider ?? "provider —"} · {pw?.claim.dateOfService ?? "DOS —"}</li>
                      <li>Billed {money(pw?.claim.totalBilled ?? null)} · member owes {money(pw?.claim.patientResponsibility ?? null)}{pw?.claim.claimNumber ? ` · #${pw.claim.claimNumber}` : ""}</li>
                      <li>Insurer on the bill: {pw?.claim.insurer ?? "—"}</li>
                      <li>Denial notice: {m.insurerLetter?.denialNoticeDate ?? "no date on record"}{m.insurerLetter ? ` · ${m.insurerLetter.letterType.replace(/_/g, " ")} ${m.insurerLetter.status}` : " · no appeal letter yet"}{pw?.claim.inCollections ? " · in collections" : ""}</li>
                    </ul>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">What the member argued</div>
                    {grounds.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">{grounds.map((g) => <span key={g} className="rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11.5px] font-medium text-blue-800">{g}</span>)}</div>
                    ) : <p className="mt-1 text-gray-500">No grounds selected yet — the member has not built the appeal.</p>}
                    <div className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Documents</div>
                    {pw?.documents.length ? (
                      <ul className="mt-1 space-y-0.5">{pw.documents.map((d) => <li key={d.id} className="truncate">{d.fileName ?? d.id.slice(0, 8)} <span className="text-gray-400">· {d.classifiedType ?? d.docType ?? "?"}</span></li>)}</ul>
                    ) : <p className="mt-1 text-gray-500">None linked.</p>}
                  </div>
                </div>

                {/* the five questions, each with what the paperwork suggests */}
                <div className="grid gap-3 border-t border-gray-100 px-4 py-4 md:grid-cols-5">
                  <label className="text-[12px] text-gray-600">Plan sponsor
                    <select className={sel} value={a.planSponsorType} onChange={(ev) => set("planSponsorType", ev.target.value)}>
                      <option value="">—</option><option value="single_employer">single employer</option><option value="mewa_association_peo">MEWA / association / PEO</option><option value="individual_marketplace">individual / marketplace</option><option value="government">government</option><option value="unknown">unknown</option>
                    </select>
                    <span className="mt-1 block text-[11px] text-gray-400">{pw?.plan?.employerName ? `Employer on file: ${pw.plan.employerName} → single employer unless the card names an association or PEO.` : /individual|marketplace|covered california|exchange/i.test(pw?.plan?.planType ?? "") ? "Plan type reads as individual / marketplace." : "Not stated in the documents — ask the member who pays the premium."}</span>
                  </label>
                  <label className="text-[12px] text-gray-600">CDI-regulated policy in the matter (incl. secondary)?
                    <select className={sel} value={a.secondaryCoverageCdi} onChange={(ev) => set("secondaryCoverageCdi", ev.target.value)}><option value="">—</option><option value="no">no</option><option value="yes">yes</option></select>
                    <span className="mt-1 block text-[11px] text-gray-400">{cls?.regulator ? `Documents say: ${cls.regulator}.` : "Not stated — a PPO or indemnity card that names the Department of Insurance is CDI; HMO / most PPOs in CA are DMHC."}</span>
                  </label>
                  <label className="text-[12px] text-gray-600">Government program (TRICARE / VA) in the matter?
                    <select className={sel} value={a.governmentProgram} onChange={(ev) => set("governmentProgram", ev.target.value)}><option value="">—</option><option value="no">no</option><option value="yes">yes</option></select>
                    <span className="mt-1 block text-[11px] text-gray-400">{govHint ? "The plan or insurer name reads like a government program." : "No government program named on the plan or the bill."}</span>
                  </label>
                  <label className="text-[12px] text-gray-600">Records from a substance-use treatment provider (42 CFR Part 2)?
                    <select className={sel} value={a.part2Records} onChange={(ev) => set("part2Records", ev.target.value)}><option value="">—</option><option value="no">no</option><option value="yes">yes</option></select>
                    <span className="mt-1 block text-[11px] text-gray-400">Judge by the PROVIDER on the bill{pw?.claim.provider ? ` (${pw.claim.provider})` : ""}: a detox, rehab or addiction-treatment program is Part 2.</span>
                  </label>
                  <label className="text-[12px] text-gray-600">Did the member ask us what to argue?
                    <select className={sel} value={a.memberAskedWhatToArgue} onChange={(ev) => set("memberAskedWhatToArgue", ev.target.value)}><option value="">—</option><option value="no">no</option><option value="yes">yes</option></select>
                    <span className="mt-1 block text-[11px] text-gray-400">{grounds.length ? "They picked their own grounds (above) — \"no\" unless a message asked us to choose." : "No grounds yet. \"Yes\" only if they asked us to choose for them."}</span>
                  </label>
                </div>

                {/* result + the explicit calls */}
                <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-gray-50 px-4 py-3">
                  <button disabled={busy === e.id} onClick={() => void screen(e.id, "evaluate")} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray-800 hover:bg-gray-100 disabled:opacity-50">{decision ? "Re-run the gates" : "Run the gates"}</button>
                  {decision && decision.eligible && !e.intake?.accepted && (
                    <button disabled={busy === e.id} onClick={() => void screen(e.id, "accept")} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">Accept</button>
                  )}
                  {decision && decision.eligible && e.intake?.accepted && <span className="text-[12.5px] font-semibold text-emerald-700">Accepted {fmtDate(e.intake.accepted.at)}</span>}
                  <input className="w-56 rounded-md border border-gray-300 px-2 py-1.5 text-[12px]" placeholder="decline reason (audit trail, optional)" value={declineReason[e.id] ?? ""} onChange={(ev) => setDeclineReason((p) => ({ ...p, [e.id]: ev.target.value }))} />
                  <button disabled={busy === e.id} onClick={() => { if (window.confirm("Decline this matter? The member is emailed their reason and keeps every free tool. You can reopen it later.")) void screen(e.id, "decline"); }} className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">Decline</button>
                  <Link href={`/admin/dfy/${e.id}`} className="ml-auto text-[12px] font-semibold text-blue-700 hover:underline">Open the matter →</Link>
                </div>
                {decision && (
                  <div className="flex flex-wrap items-center gap-1.5 border-t border-gray-100 px-4 py-3">
                    <span className={`mr-2 text-[12.5px] font-semibold ${decision.eligible ? "text-emerald-700" : "text-red-700"}`}>{decision.eligible ? "Every gate passed — eligible" : `A gate failed — ${decision.declineReason}`}</span>
                    {decision.gates.map((g) => (
                      <span key={g.id} title={g.reason ?? ""} className={`rounded-md border px-1.5 py-0.5 text-[11px] ${g.pass ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}`}>{g.pass ? "✓" : "✗"} {g.label}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* declined at intake — reversible */}
      {data && data.matters.some((m) => m.engagement.status === "terminated" && (m.engagement.metadata?.closedReason ?? "").startsWith("declined at intake")) && (
        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Declined at intake</h2>
          <p className="mt-1 text-[12px] text-gray-500">The member was emailed their plain-language reason. Reopen puts the matter back in intake with the decision cleared; the audit trail keeps both.</p>
          <ul className="mt-3 divide-y divide-gray-100">
            {data.matters.filter((m) => m.engagement.status === "terminated" && (m.engagement.metadata?.closedReason ?? "").startsWith("declined at intake")).map((m) => (
              <li key={m.engagement.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[12.5px]">
                <span><b className="text-gray-900">{who(m.member)}</b> · claim {m.engagement.claim_id.slice(0, 8)}… · <span className="text-gray-500">{m.engagement.metadata?.closedReason}</span></span>
                <button disabled={busy === m.engagement.id} onClick={() => void screen(m.engagement.id, "reopen")} className="rounded-lg border border-gray-300 bg-white px-3 py-1 text-[12px] font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-50">Reopen</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sponsors && (
        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Sponsors (employer-paid lane) — admin</h2>
          <p className="mt-1 text-[12px] text-gray-500">Paper before code: a sponsor code works at intake only once the signed agreement date is on file and the sponsor is active. Reporting to a sponsor is aggregate-only — counts across at least {5} members, never a member or a claim.</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-gray-500"><th className="px-2 py-1.5">Code</th><th className="px-2 py-1.5">Name</th><th className="px-2 py-1.5">Agreement signed</th><th className="px-2 py-1.5">Active</th><th className="px-2 py-1.5"></th></tr></thead>
              <tbody>
                {sponsors.map((sp) => (
                  <tr key={sp.id} className="border-t border-gray-100">
                    <td className="px-2 py-1.5 font-mono">{sp.code}</td><td className="px-2 py-1.5">{sp.name}</td>
                    <td className="px-2 py-1.5">{sp.agreement_signed_at ? fmtDate(sp.agreement_signed_at) : <span className="text-red-700">not signed — code unusable</span>}</td>
                    <td className="px-2 py-1.5">{sp.active ? "yes" : "no"}</td>
                    <td className="px-2 py-1.5"><button className="text-[12px] font-semibold text-blue-700 hover:underline" onClick={async () => { const t = await token(); const r = await fetch(`/api/admin/dfy/sponsors/${sp.id}/report`, { headers: { Authorization: `Bearer ${t}` } }); if (r.ok) setReport(((await r.json()) as { report: SponsorReport }).report); }}>Aggregate report</button></td>
                  </tr>
                ))}
                {sponsors.length === 0 && <tr><td className="px-2 py-2 text-gray-500" colSpan={5}>No sponsors yet.</td></tr>}
              </tbody>
            </table>
          </div>
          {report && (
            <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-[12.5px]">
              <b>{report.name}</b> ({report.code}) · {report.suppressed ? `fewer than ${report.k} matters — suppressed` : `${report.total} matters`}
              {!report.suppressed && report.byStatus && <span className="ml-2 text-gray-600">by status: {Object.entries(report.byStatus).map(([k, v]) => `${k} ${v}`).join(" · ")}</span>}
              {!report.suppressed && report.byDetermination && Object.keys(report.byDetermination).length > 0 && <span className="ml-2 text-gray-600">by determination: {Object.entries(report.byDetermination).map(([k, v]) => `${k} ${v}`).join(" · ")}</span>}
            </div>
          )}
          <div className="mt-3 grid gap-2 sm:grid-cols-5">
            <input className="rounded-md border border-gray-300 px-2 py-1 text-[12.5px]" placeholder="code (e.g. ACME-2026)" value={sponsorForm.code} onChange={(e) => setSponsorForm({ ...sponsorForm, code: e.target.value })} />
            <input className="rounded-md border border-gray-300 px-2 py-1 text-[12.5px]" placeholder="sponsor name" value={sponsorForm.name} onChange={(e) => setSponsorForm({ ...sponsorForm, name: e.target.value })} />
            <input className="rounded-md border border-gray-300 px-2 py-1 text-[12.5px]" placeholder="contact email" value={sponsorForm.contactEmail} onChange={(e) => setSponsorForm({ ...sponsorForm, contactEmail: e.target.value })} />
            <input className="rounded-md border border-gray-300 px-2 py-1 text-[12.5px]" type="date" value={sponsorForm.agreementSignedAt} onChange={(e) => setSponsorForm({ ...sponsorForm, agreementSignedAt: e.target.value })} title="agreement signed on" />
            <button disabled={!sponsorForm.code || !sponsorForm.name} className="rounded-lg bg-gray-900 px-3 py-1 text-[12px] font-semibold text-white disabled:opacity-50" onClick={async () => { const r = await post("/api/admin/dfy/sponsors", { code: sponsorForm.code, name: sponsorForm.name, contactEmail: sponsorForm.contactEmail || undefined, agreementSignedAt: sponsorForm.agreementSignedAt || undefined, active: true }); if (!r.ok) setError(String(r.json.error ?? "Could not save sponsor")); else { setSponsorForm({ code: "", name: "", contactEmail: "", agreementSignedAt: "" }); refresh(); } }}>Save sponsor</button>
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Invite a member (pilot is invitation-only)</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          <input className="rounded-md border border-gray-300 px-2 py-1 text-[12.5px]" placeholder="member email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
          <input className="rounded-md border border-gray-300 px-2 py-1 text-[12.5px]" placeholder="claim id (uuid)" value={inviteClaim} onChange={(e) => setInviteClaim(e.target.value)} />
          <select className="rounded-md border border-gray-300 bg-white px-2 py-1 text-[12.5px]" value={invitePayer} onChange={(e) => setInvitePayer(e.target.value as "member_paid" | "sponsor_paid")}>
            <option value="member_paid">member-paid (free pilot)</option><option value="sponsor_paid">sponsor-paid (employer code)</option>
          </select>
          {invitePayer === "sponsor_paid" && <input className="rounded-md border border-gray-300 px-2 py-1 text-[12.5px]" placeholder="employer voucher code" value={inviteSponsor} onChange={(e) => setInviteSponsor(e.target.value)} />}
        </div>
        <div className="mt-2 flex items-center gap-3">
          <button onClick={() => void invite()} disabled={!inviteEmail || !inviteClaim} className="rounded-lg bg-gray-900 px-3 py-1 text-[12px] font-semibold text-white disabled:opacity-50">Open engagement</button>
          {inviteMsg && <span className="text-[12.5px] text-gray-600">{inviteMsg}</span>}
        </div>
      </section>
    </div>
  );
}
