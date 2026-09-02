"use client";
/**
 * IntakeCard — the ONE intake-screening surface, rendered by the queue and by
 * the matter page (the Slack ping lands on the matter page; screening must be
 * there too, before any act is possible). The member's paperwork on top, the
 * seven questions pre-filled from it, the gates as an explicit result, and the
 * operator's explicit calls: Run the gates → Accept / Decline; Reopen lives
 * with the declined list on the queue.
 */
import Link from "next/link";

interface UserDisplay { userId: string; displayName: string | null; email: string | null }
interface Gate { id: string; label: string; pass: boolean; reason: string | null }
export type IntakeAction = "evaluate" | "accept" | "decline" | "reopen";

export interface IntakeMatter {
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

export interface Answers { planSponsorType: string; caRegulator: string; coverageType: string; secondaryCoverageCdi: string; governmentProgram: string; memberAskedWhatToArgue: string; part2Records: string }

/** What the paperwork suggests for each question — the operator reviews rather than fills (Andrew: as few steps as possible). */
function cdiInsurerHint(insurer: string | null | undefined): boolean {
  return /life\s*(&|and)\s*health|\blife\b/i.test(insurer ?? "");
}

export function defaultAnswers(m: IntakeMatter): Answers {
  const pw = m.paperwork;
  const cls = (pw?.plan?.classification ?? null) as { caRegulator?: string; coverageType?: string } | null;
  const planText = `${pw?.plan?.planType ?? ""} ${pw?.plan?.insurerName ?? ""} ${pw?.plan?.planName ?? ""}`;
  const metalTier = /\b(bronze|silver|gold|platinum|minimum coverage|catastrophic)\b/i.test(planText) || /individual|marketplace|covered california|exchange/i.test(planText);
  const gov = /medicare|medicaid|medi-cal|tricare|\bva\b|veterans|champva/i.test(planText);
  const cdiInsurer = /life\s*(&|and)\s*health|\blife\b/i.test(pw?.plan?.insurerName ?? "");
  const regulator = cls?.caRegulator ?? (cdiInsurer ? "CDI" : "");
  const part2 = /rehab|recovery|detox|addiction|substance|sober|treatment center|behavioral health/i.test(pw?.claim.provider ?? "");
  const scopeSigned = !!(m.engagement.consent_event_ids ?? {})["dfy_scope_of_engagement"];
  return {
    planSponsorType: pw?.plan?.employerName ? "single_employer" : metalTier ? "individual_marketplace" : "",
    caRegulator: regulator,
    coverageType: cls?.coverageType ?? (gov ? "" : pw?.plan?.employerName ? "" : metalTier ? "commercial_fully_insured" : ""),
    secondaryCoverageCdi: regulator === "CDI" ? "yes" : "no",
    governmentProgram: gov ? "" : "no",
    memberAskedWhatToArgue: scopeSigned || (pw?.grounds.length ?? 0) > 0 ? "no" : "",
    part2Records: part2 ? "" : "no",
  };
}


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

export function IntakeCard({ m, answers, onAnswers, declineReason, onDeclineReason, busy, onScreen, refusalRunwayBusinessDays }: {
  m: IntakeMatter;
  answers: Answers | undefined;
  onAnswers: (a: Answers) => void;
  declineReason: string;
  onDeclineReason: (v: string) => void;
  busy: boolean;
  onScreen: (action: IntakeAction) => void | Promise<void>;
  refusalRunwayBusinessDays: number;
}) {
  const runwayTone = (n: number | null) => (n === null ? "text-gray-500" : n < refusalRunwayBusinessDays ? "font-semibold text-red-700" : n < refusalRunwayBusinessDays * 2 ? "font-semibold text-amber-700" : "font-semibold text-emerald-700");
            const e = m.engagement;
            const a = answers ?? defaultAnswers(m);
            const set = (k: keyof Answers, v: string) => onAnswers({ ...a, [k]: v });
            const decision = e.intake?.decision ?? null;
            const pw = m.paperwork;
            const signed = Object.keys(e.consent_event_ids ?? {}).length;
            const grounds = (pw?.grounds ?? []).map((g) => g.replace(/_/g, " "));
            const govHint = /medicare|medicaid|medi-cal|tricare|\bva\b|veterans|champva/i.test(`${pw?.plan?.planType ?? ""} ${pw?.plan?.insurerName ?? ""} ${pw?.plan?.planName ?? ""}`);
            const cls = pw?.plan?.classification as { caRegulator?: string; regulator?: string; coverageType?: string; fundingType?: string } | null | undefined;
            const sel = "mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[12.5px]";
            const money = (n: number | null) => (n === null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  return (
              <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
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
                <div className="grid gap-3 border-t border-gray-100 px-4 py-4 text-[12.5px] text-gray-700 md:grid-cols-3">
                  <div className="rounded-xl bg-gray-50 p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Plan (from their documents)</div>
                    {pw?.plan ? (
                      <ul className="mt-1 space-y-0.5">
                        <li className="font-medium text-gray-900">{pw.plan.planName ?? "plan name not parsed"}</li>
                        <li>{pw.plan.insurerName ?? "insurer —"} · {pw.plan.planType ?? "type —"}{pw.plan.state ? ` · ${pw.plan.state}` : ""}</li>
                        <li>Employer: {pw.plan.employerName ?? "not stated"} · Group: {pw.plan.groupNumber ?? "—"}</li>
                        <li>Regulator: {cls?.caRegulator ?? cls?.regulator ?? "not stated in documents"}{cls?.coverageType ? ` · ${String(cls.coverageType).replace(/_/g, " ")}` : ""}{cls?.fundingType ? ` · ${String(cls.fundingType).replace(/_/g, " ")}` : ""}</li>
                      </ul>
                    ) : <p className="mt-1 text-gray-500">No plan pinned to this claim.</p>}
                  </div>
                  <div className="rounded-xl bg-gray-50 p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Claim + denial</div>
                    <ul className="mt-1 space-y-0.5">
                      <li className="font-medium text-gray-900">{pw?.claim.provider ?? "provider —"} · {pw?.claim.dateOfService ?? "DOS —"}</li>
                      <li>Billed {money(pw?.claim.totalBilled ?? null)} · member owes {money(pw?.claim.patientResponsibility ?? null)}{pw?.claim.claimNumber ? ` · #${pw.claim.claimNumber}` : ""}</li>
                      <li>Insurer on the bill: {pw?.claim.insurer ?? "—"}</li>
                      <li>Denial notice: {m.insurerLetter?.denialNoticeDate ?? "no date on record"}{m.insurerLetter ? ` · ${m.insurerLetter.letterType.replace(/_/g, " ")} ${m.insurerLetter.status}` : " · no appeal letter yet"}{pw?.claim.inCollections ? " · in collections" : ""}</li>
                    </ul>
                  </div>
                  <div className="rounded-xl bg-gray-50 p-3">
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

                {/* the questions — pre-filled from the paperwork; the operator reviews, the hints sit below in one strip */}
                <div className="grid gap-3 border-t border-gray-100 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="text-[12px] text-gray-600">Regulator named in the documents
                    <select className={sel} value={a.caRegulator} onChange={(ev) => set("caRegulator", ev.target.value)}><option value="">—</option><option value="DMHC">DMHC</option><option value="CDI">CDI</option><option value="unknown">not named</option></select>
                  </label>
                  <label className="text-[12px] text-gray-600">Coverage type
                    <select className={sel} value={a.coverageType} onChange={(ev) => set("coverageType", ev.target.value)}><option value="">—</option><option value="commercial_fully_insured">fully insured (insurer bears the risk)</option><option value="employer_self_funded">self-funded employer (ERISA / ASO)</option><option value="employer_self_funded_public">self-funded public or church employer</option><option value="medicare">Medicare</option><option value="medicaid">Medi-Cal / Medicaid</option></select>
                  </label>
                  <label className="text-[12px] text-gray-600">Plan sponsor
                    <select className={sel} value={a.planSponsorType} onChange={(ev) => set("planSponsorType", ev.target.value)}>
                      <option value="">—</option><option value="single_employer">single employer</option><option value="mewa_association_peo">MEWA / association / PEO</option><option value="individual_marketplace">individual / marketplace</option><option value="government">government</option><option value="unknown">unknown</option>
                    </select>
                  </label>
                  <label className="text-[12px] text-gray-600">CDI-regulated policy in the matter (incl. secondary)?
                    <select className={sel} value={a.secondaryCoverageCdi} onChange={(ev) => set("secondaryCoverageCdi", ev.target.value)}><option value="">—</option><option value="no">no</option><option value="yes">yes</option></select>
                  </label>
                  <label className="text-[12px] text-gray-600">TRICARE or VA / CHAMPVA in the matter?
                    <select className={sel} value={a.governmentProgram} onChange={(ev) => set("governmentProgram", ev.target.value)}><option value="">—</option><option value="no">no</option><option value="yes">yes</option></select>
                  </label>
                  <label className="text-[12px] text-gray-600">Substance-use treatment records (42 CFR Part 2)?
                    <select className={sel} value={a.part2Records} onChange={(ev) => set("part2Records", ev.target.value)}><option value="">—</option><option value="no">no</option><option value="yes">yes</option></select>
                  </label>
                  <label className="text-[12px] text-gray-600">Did the member ask us what to argue?
                    <select className={sel} value={a.memberAskedWhatToArgue} onChange={(ev) => set("memberAskedWhatToArgue", ev.target.value)}><option value="">—</option><option value="no">no</option><option value="yes">yes</option></select>
                  </label>
                </div>
                <div className="border-t border-gray-100 bg-gray-50/60 px-4 py-3 text-[11.5px] leading-relaxed text-gray-500">
                  <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-gray-400">From the paperwork</div>
                  <ul className="space-y-0.5">
                    <li><b className="text-gray-600">Regulator.</b> DMHC = Department of Managed Health Care: licenses HMOs and most California PPOs, including Blue Shield of California. CDI = California Department of Insurance: indemnity and some PPO <i>insurance policies</i>, e.g. Blue Shield of California Life &amp; Health. Read the agency named on the card, the EOB or the SBC&apos;s complaints section — never guess from &quot;PPO&quot;.{cls?.caRegulator ? ` The member's own screening says ${cls.caRegulator}.` : cdiInsurerHint(pw?.plan?.insurerName) ? " This insurer name reads as a CDI-licensed life & health company." : pw?.plan?.insurerName ? ` ${pw.plan.insurerName} plans are DMHC-licensed unless the card names the Department of Insurance.` : ""}</li>
                    <li><b className="text-gray-600">Coverage type.</b> Fully insured = the insurer bears the risk (individual, marketplace, most employers). Self-funded = the employer pays claims and the insurer only administers (the card or SBC says &quot;administered by&quot; / &quot;ASO&quot;). {defaultAnswers(m).coverageType === "commercial_fully_insured" ? "A metal-tier plan with no employer on file reads as fully insured." : "Not stated in the documents."}</li>
                    <li><b className="text-gray-600">Plan sponsor.</b> {pw?.plan?.employerName ? `Employer on file: ${pw.plan.employerName} — single employer unless the card names an association or PEO.` : defaultAnswers(m).planSponsorType === "individual_marketplace" ? "A metal-tier / marketplace plan name — individual coverage, no employer." : "Not stated — ask who pays the premium."}</li>
                    <li><b className="text-gray-600">Government programs.</b> TRICARE and VA / CHAMPVA anywhere in the matter; Medicare and Medi-Cal are caught by the coverage type. {govHint ? "The plan or insurer name reads like a government program — confirm." : "None named on the plan or the bill."}</li>
                    <li><b className="text-gray-600">Part 2.</b> Judge by the provider on the bill{pw?.claim.provider ? ` (${pw.claim.provider})` : ""}: a detox, rehab, or addiction-treatment program is Part 2; a hospital or medical group is not.</li>
                    <li><b className="text-gray-600">What to argue.</b> {grounds.length ? "They picked their own grounds (above)" : "No grounds yet"}{(e.consent_event_ids ?? {})["dfy_scope_of_engagement"] ? ", and their signed Scope of Engagement says Candid will not choose for them" : ""} — &quot;yes&quot; only if a message asked us to choose.</li>
                  </ul>
                </div>

                {/* result + the explicit calls */}
                <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-gray-50 px-4 py-3">
                  <button disabled={busy} onClick={() => void onScreen("evaluate")} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray-800 hover:bg-gray-100 disabled:opacity-50">{decision ? "Re-run the gates" : "Run the gates"}</button>
                  {decision && decision.eligible && !e.intake?.accepted && (
                    <button disabled={busy} onClick={() => void onScreen("accept")} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">Accept</button>
                  )}
                  {decision && decision.eligible && e.intake?.accepted && <span className="text-[12.5px] font-semibold text-emerald-700">Accepted {fmtDate(e.intake.accepted.at)}</span>}
                  <input className="w-56 rounded-md border border-gray-300 px-2 py-1.5 text-[12px]" placeholder="decline reason (audit trail, optional)" value={declineReason} onChange={(ev) => onDeclineReason(ev.target.value)} />
                  <button disabled={busy} onClick={() => { if (window.confirm("Decline this matter? The member is emailed their reason and keeps every free tool. You can reopen it later.")) void onScreen("decline"); }} className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">Decline</button>
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
}
