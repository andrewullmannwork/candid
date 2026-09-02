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
    intake: { decision?: { eligible: boolean; gates: Gate[]; declineReason: string | null } };
    consent_event_ids: Record<string, unknown>;
  };
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
  async function screen(id: string) {
    const a = answers[id] ?? { planSponsorType: "", secondaryCoverageCdi: "", governmentProgram: "", memberAskedWhatToArgue: "", part2Records: "" };
    const tri = (v: string) => (v === "yes" ? true : v === "no" ? false : null);
    setBusy(id);
    const r = await post(`/api/admin/dfy/engagements/${id}/screen`, {
      planSponsorType: a.planSponsorType || null,
      secondaryCoverageCdi: tri(a.secondaryCoverageCdi),
      governmentProgram: tri(a.governmentProgram),
      memberAskedWhatToArgue: tri(a.memberAskedWhatToArgue),
      part2Records: tri(a.part2Records),
    });
    if (!r.ok) setError(String(r.json.error ?? "Screening failed"));
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
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Intake screening — people who asked for the service but are not accepted yet</h2>
        <p className="mt-2 text-[12.5px] text-gray-600">
          <b className="text-gray-900">Purpose:</b> this is the legal front door. We may only take matters that need pure execution (paperwork, submission, deadlines) — never matters that would require us to exercise judgment about what to argue, or matters in coverage types the law walls off. Each applicant runs the gate checklist; every gate must pass or the applicant is automatically declined with a written reason (fail-closed — a maybe is a no). Declined people keep the entire free tool. Answer the three document questions below from the member&apos;s own paperwork, then screen.
        </p>
        {data && data.applicants.length === 0 && <p className="mt-3 text-sm text-gray-500">No applicants waiting.</p>}
        <div className="mt-3 space-y-4">
          {data?.applicants.map((m) => {
            const e = m.engagement;
            const a = answers[e.id] ?? { planSponsorType: "", secondaryCoverageCdi: "", governmentProgram: "", memberAskedWhatToArgue: "", part2Records: "" };
            const set = (k: keyof typeof a, v: string) => setAnswers((p) => ({ ...p, [e.id]: { ...a, [k]: v } }));
            const decision = e.intake?.decision;
            const sel = "rounded-md border border-gray-300 bg-white px-2 py-1 text-[12px]";
            return (
              <div key={e.id} className="rounded-xl border border-gray-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium text-gray-900">{who(m.member)} <span className="text-[11px] font-normal text-gray-400">{m.member.state ?? "state —"} · claim {e.claim_id.slice(0, 8)}… · {e.payer}{e.sponsor_ref ? ` · ${e.sponsor_ref}` : ""}{e.operator_user_id ? "" : " · applied (unclaimed)"}</span></div>
                  <div className={runwayTone(m.runwayBusinessDays)}>{m.runwayBusinessDays === null ? "no dated window" : `${m.runwayBusinessDays} business days`}</div>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-5">
                  <label className="text-[12px] text-gray-600">Plan sponsor (from documents)
                    <select className={`${sel} mt-1 w-full`} value={a.planSponsorType} onChange={(ev) => set("planSponsorType", ev.target.value)}>
                      <option value="">—</option><option value="single_employer">single employer</option><option value="mewa_association_peo">MEWA / association / PEO</option><option value="individual_marketplace">individual / marketplace</option><option value="unknown">cannot tell</option>
                    </select>
                  </label>
                  <label className="text-[12px] text-gray-600">Any CDI-regulated policy in the matter (incl. secondary)?
                    <select className={`${sel} mt-1 w-full`} value={a.secondaryCoverageCdi} onChange={(ev) => set("secondaryCoverageCdi", ev.target.value)}><option value="">—</option><option value="no">no</option><option value="yes">yes</option></select>
                  </label>
                  <label className="text-[12px] text-gray-600">Government program (TRICARE / VA) in the matter?
                    <select className={`${sel} mt-1 w-full`} value={a.governmentProgram} onChange={(ev) => set("governmentProgram", ev.target.value)}><option value="">—</option><option value="no">no</option><option value="yes">yes</option></select>
                  </label>
                  <label className="text-[12px] text-gray-600">Any records from a substance-use treatment provider (42 CFR Part 2)?
                    <select className={`${sel} mt-1 w-full`} value={a.part2Records} onChange={(ev) => set("part2Records", ev.target.value)}><option value="">—</option><option value="no">no</option><option value="yes">yes</option></select>
                  </label>
                  <label className="text-[12px] text-gray-600">Did the member ask us what to argue?
                    <select className={`${sel} mt-1 w-full`} value={a.memberAskedWhatToArgue} onChange={(ev) => set("memberAskedWhatToArgue", ev.target.value)}><option value="">—</option><option value="no">no</option><option value="yes">yes</option></select>
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button disabled={busy === e.id} onClick={() => void screen(e.id)} className="rounded-lg bg-blue-600 px-3 py-1 text-[12px] font-semibold text-white disabled:opacity-50">Screen</button>
                  <Link href={`/admin/dfy/${e.id}`} className="text-[12px] font-semibold text-blue-700 hover:underline">Open →</Link>
                  {decision && (
                    <span className={`text-[12.5px] font-semibold ${decision.eligible ? "text-emerald-700" : "text-red-700"}`}>
                      {decision.eligible ? "eligible — offer engagement" : `declined — ${decision.declineReason}`}
                    </span>
                  )}
                </div>
                {decision && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {decision.gates.map((g) => (
                      <span key={g.id} title={g.reason ?? g.label} className={`rounded-md border px-1.5 py-0.5 text-[10.5px] font-bold ${g.pass ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}`}>{g.id} {g.label}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

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
