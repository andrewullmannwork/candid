/**
 * matter — ONE assembly of a DFY matter's operator-facing summary (S330), read
 * by the queue, the matter view and the screening route so the three can never
 * disagree about phase, runway or composition.
 *
 * Every member-owned read goes through userScoped(<the member>) — the grant
 * names the member, ownership is theirs. Deadline runway is the deadline
 * engine's own output (the member's rail reads the same columns), never a
 * second derivation.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped } from "@/lib/security/user-scoped";
import type { DfyEngagementRow } from "@/lib/security/operator-scoped";
import { CASE_TIMELINE_DISPUTE_COLUMNS } from "@/lib/case/load-case-timeline";
import { getLetterEnclosures } from "@/lib/disputes/letter-type";
import { PLAN_FACING_INSTRUMENTS, signedInstruments, type DfyInstrumentType } from "@/lib/dfy/paper";
import { signedInstrumentFile } from "@/lib/dfy/instrument-files";
import { resolvePlanContext } from "@/lib/disputes/plan-context";
import { resolveLetterType, type ProjectorDisputeRow } from "@/lib/case/timeline-projector";
import { evaluateDeadline, readDeadlineConfig } from "@/lib/disputes/deadline-engine";
import { businessDaysUntil } from "./business-days";
import { loadCompositionProof, type CompositionProof } from "./operator-action";

export interface MatterInsurerLetter {
  disputeId: string;
  letterType: string;
  status: string;
  sentAt: string | null;
  governingDeadlineDate: string | null;
  deadlineType: string | null;
  /** dispute_outcomes.metadata.denialNoticeDate — the adverse determination the appeal answers. */
  denialNoticeDate: string | null;
  /**
   * S331 — what an operator needs to actually SEND this letter. The matter view
   * rendered the member's rail but starved it of the artifacts, so the operator
   * could see the step and not perform it.
   *
   * Every field comes from the resolver the MEMBER's own letter uses — the
   * stored letter body, `resolvePlanContext` for the recipient, and the pure
   * `getLetterEnclosures` — so operator and member cannot be shown different
   * letters, different addresses, or different envelopes.
   */
  letterContent: string | null;
  enclosures: readonly string[];
  recipient: {
    name: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    phone: string | null;
  } | null;
}

export interface DfyEventSummary {
  /** claim_case_events PK — the handle an undo names. */
  id: string | null;
  kind: string;
  occurredAt: string;
  disputeId: string | null;
  payload: Record<string, unknown>;
}

export interface UserDisplay {
  userId: string;
  displayName: string | null;
  email: string | null;
}

/** The member's own paperwork, read through their ownership — what the operator screens FROM. */
export interface MatterPaperwork {
  plan: { id: string; planName: string | null; insurerName: string | null; planType: string | null; state: string | null; employerName: string | null; groupNumber: string | null; classification: Record<string, unknown> | null } | null;
  claim: { claimNumber: string | null; provider: string | null; insurer: string | null; dateOfService: string | null; totalBilled: number | null; patientResponsibility: number | null; inCollections: boolean };
  /** The grounds the member selected (ground_selected payload.groundType), newest first, deduped — "what the member argued". */
  grounds: string[];
  documents: Array<{ id: string; fileName: string | null; docType: string | null; classifiedType: string | null; createdAt: string | null }>;
}

export interface MatterSummary {
  engagement: DfyEngagementRow;
  /** Absent only in fixtures that build a summary by hand. */
  paperwork?: MatterPaperwork;
  /** S331 — the signed designation + authorization the operator sends to the plan. */
  submittablePaper: SubmittablePaper[];
  member: UserDisplay & { state: string | null };
  holder: UserDisplay | null;
  composition: CompositionProof;
  insurerLetter: MatterInsurerLetter | null;
  /** Business days to the governing deadline; null = no dated window on record. */
  runwayBusinessDays: number | null;
  events: DfyEventSummary[];
  lastAct: DfyEventSummary | null;
  phase: string;
}

const APPEAL_TYPES = new Set(["insurance_appeal", "external_review"]);

/** users.display_name / email for a set of ids (users is not a user-owned-registered table). */
export async function loadUsersDisplay(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, UserDisplay>> {
  const out = new Map<string, UserDisplay>();
  const unique = [...new Set(ids.filter((x) => typeof x === "string" && x.length > 0))];
  if (unique.length === 0) return out;
  const { data } = await supabase.from("users").select("id, display_name, email").in("id", unique);
  for (const r of (data ?? []) as Array<{ id: string; display_name?: string | null; email?: string | null }>) {
    out.set(r.id, { userId: r.id, displayName: r.display_name ?? null, email: r.email ?? null });
  }
  return out;
}

/** The appeal this engagement executes: the latest non-cancelled insurer-track letter on the claim. */
export async function loadInsurerLetter(
  supabase: SupabaseClient,
  memberUserId: string,
  claimId: string,
): Promise<MatterInsurerLetter | null> {
  const { data } = await userScoped(supabase, memberUserId)
    .table("dispute_outcomes")
    .select(`${CASE_TIMELINE_DISPUTE_COLUMNS}, letter_content`)
    .eq("claim_id", claimId)
    .order("created_at", { ascending: false });
  const rows = ((data ?? []) as unknown[]) as ProjectorDisputeRow[];
  for (const d of rows) {
    if (d.status === "cancelled") continue;
    const letterType = resolveLetterType(d);
    if (!APPEAL_TYPES.has(letterType)) continue;
    const meta = (d.metadata ?? {}) as Record<string, unknown>;
    // The SAME recipient the member's letter mails to — one resolver, so the
    // operator can never address an envelope the member's copy disagrees with.
    let recipient: MatterInsurerLetter["recipient"] = null;
    try {
      const ctx = await resolvePlanContext(supabase, { userId: memberUserId, claimId });
      const ins = ctx?.insurer ?? null;
      const addr = ins?.appealsAddress ?? null;
      if (ins || addr) {
        recipient = {
          name: ins?.name ?? null,
          addressLine1: addr?.line1 ?? null,
          addressLine2: addr?.line2 ?? null,
          city: addr?.city ?? null,
          state: addr?.state ?? null,
          postalCode: addr?.postalCode ?? null,
          phone: ins?.appealsPhone ?? null,
        };
      }
    } catch (err) {
      console.error("[dfy matter] recipient resolve failed (non-fatal):", err);
    }
    return {
      disputeId: d.id,
      letterType,
      status: d.status,
      sentAt: d.sent_at ?? null,
      governingDeadlineDate: d.governing_deadline_date ?? null,
      deadlineType: d.deadline_type ?? null,
      denialNoticeDate: typeof meta.denialNoticeDate === "string" ? meta.denialNoticeDate : null,
      letterContent: typeof (d as { letter_content?: unknown }).letter_content === "string"
        ? ((d as { letter_content?: string }).letter_content ?? null)
        : null,
      enclosures: getLetterEnclosures(letterType),
      recipient,
    };
  }
  return null;
}

/**
 * Runway to the governing deadline. Prefers the persisted deadline (the rail's
 * own); when the letter has none yet, derives it from the denial date through
 * the same deadline engine the member's follow-ups use.
 */
export async function computeRunway(
  supabase: SupabaseClient,
  letter: MatterInsurerLetter | null,
  now: Date,
): Promise<number | null> {
  if (!letter) return null;
  let governing = letter.governingDeadlineDate;
  if (!governing && letter.denialNoticeDate) {
    const config = await readDeadlineConfig(supabase);
    const r = evaluateDeadline(
      { letterType: "insurance_appeal", denialNoticeDate: letter.denialNoticeDate, now },
      config,
    );
    governing = r.governingDeadlineDate;
  }
  return businessDaysUntil(now, governing);
}

export async function loadDfyEvents(
  supabase: SupabaseClient,
  memberUserId: string,
  claimId: string,
): Promise<DfyEventSummary[]> {
  const { data } = await userScoped(supabase, memberUserId)
    .table("claim_case_events")
    .select("id, kind, dispute_id, occurred_at, payload")
    .eq("claim_id", claimId)
    .like("kind", "dfy_%")
    .order("occurred_at", { ascending: true });
  return ((data ?? []) as Array<{ id: string; kind: string; dispute_id: string | null; occurred_at: string; payload: Record<string, unknown> | null }>).map(
    (e) => ({ id: e.id ?? null, kind: e.kind, occurredAt: e.occurred_at, disputeId: e.dispute_id ?? null, payload: e.payload ?? {} }),
  );
}

const ACT_PHASE: Readonly<Record<string, string>> = {
  dfy_designation_submitted: "Designation — awaiting plan ack",
  dfy_designation_acknowledged: "Designated — ready to transmit",
  dfy_document_requested: "Documents requested",
  dfy_appeal_transmitted: "Internal appeal — transmitted",
  dfy_status_called: "Status confirmed",
  dfy_response_recorded: "Plan response — member review",
  dfy_offer_relayed: "Offer relayed — member review",
  dfy_packet_prepared: "State level — the member files",
  dfy_determination_recorded: "Determination recorded",
  dfy_audit_logged: "Audit review logged",
};

export function derivePhase(engagement: DfyEngagementRow, composition: CompositionProof, lastAct: DfyEventSummary | null): string {
  switch (engagement.status) {
    case "eligibility_pending": {
      const decision = (engagement.intake as { decision?: { eligible?: boolean } }).decision;
      if (!decision) return "Screening";
      return decision.eligible ? "Eligible — awaiting the member's paper" : "Declined at intake";
    }
    case "signed":
      return "Waiting on activation";
    case "active":
      if (!(composition.groundSelected && composition.letterAdopted)) return "Waiting on member — no composition on record";
      if (!lastAct) return "Ready — designation not yet submitted";
      return ACT_PHASE[lastAct.kind] ?? lastAct.kind;
    case "converted":
      return "Converted — back to the member";
    case "terminated":
      return "Terminated";
    case "completed":
      return "Completed";
  }
}

export interface SubmittablePaper {
  type: DfyInstrumentType;
  fileName: string;
  signedName: string | null;
  signedAt: string | null;
  /** Short-lived signed storage URL — the SAME resolver the member's page uses. */
  pdfUrl: string | null;
  /** The storage object, for the server-side packet merge. */
  storagePath: string | null;
}

/**
 * The signed, plan-facing paper an operator needs in hand (S331).
 *
 * Which instruments those are is a fact about the paper and lives with the
 * paper (`PLAN_FACING_INSTRUMENTS`); turning one into a file is
 * `signedInstrumentFile`, shared with the member's own page. This function only
 * joins the two, so the operator downloads the byte-identical artifact.
 */
export async function loadSubmittablePaper(
  supabase: SupabaseClient,
  memberUserId: string,
  consentEventIds: Record<string, unknown>,
): Promise<SubmittablePaper[]> {
  const signed = signedInstruments(consentEventIds ?? {});
  const out: SubmittablePaper[] = [];
  for (const type of PLAN_FACING_INSTRUMENTS) {
    const ref = signed[type];
    if (!ref?.documentId) continue;
    const file = await signedInstrumentFile(supabase, memberUserId, ref.documentId);
    out.push({
      type,
      fileName: file.fileName ?? type,
      signedName: ref.signedName ?? null,
      signedAt: ref.signedAt ?? null,
      pdfUrl: file.pdfUrl,
      storagePath: file.storagePath,
    });
  }
  return out;
}

export async function loadPaperwork(supabase: SupabaseClient, memberUserId: string, claimId: string): Promise<MatterPaperwork> {
  const scoped = userScoped(supabase, memberUserId);
  const { data: c } = await scoped.table("claims").select("id, claim_number, date_of_service, total_billed, total_patient_responsibility, insurance_plan_id, source_document_id, metadata").eq("id", claimId).maybeSingle();
  const claim = c as { claim_number: string | null; date_of_service: string | null; total_billed: number | null; total_patient_responsibility: number | null; insurance_plan_id: string | null; source_document_id: string | null; metadata: Record<string, unknown> | null } | null;
  const meta = claim?.metadata ?? {};
  const [planRes, groundsRes] = await Promise.all([
    claim?.insurance_plan_id
      ? scoped.table("insurance_plans").select("id, plan_name, insurer_name, plan_type, state, employer_name, group_number, source_document_id, metadata").eq("id", claim.insurance_plan_id).maybeSingle()
      : Promise.resolve({ data: null }),
    scoped.table("claim_case_events").select("payload, occurred_at").eq("claim_id", claimId).eq("kind", "ground_selected").order("occurred_at", { ascending: false }).limit(20),
  ]);
  const plan = planRes.data as { id: string; plan_name: string | null; insurer_name: string | null; plan_type: string | null; state: string | null; employer_name: string | null; group_number: string | null; source_document_id: string | null; metadata: Record<string, unknown> | null } | null;
  const docIds = [claim?.source_document_id, plan?.source_document_id].filter((x): x is string => typeof x === "string");
  let docQuery = scoped.table("documents").select("id, file_name, doc_type, classified_type, created_at, linked_insurance_plan_id");
  docQuery = plan ? docQuery.or(`id.in.(${docIds.length ? docIds.join(",") : "00000000-0000-0000-0000-000000000000"}),linked_insurance_plan_id.eq.${plan.id}`) : docQuery.in("id", docIds.length ? docIds : ["00000000-0000-0000-0000-000000000000"]);
  const { data: docs } = await docQuery.order("created_at", { ascending: false }).limit(12);
  const grounds: string[] = [];
  for (const g of (groundsRes.data ?? []) as Array<{ payload: Record<string, unknown> | null }>) {
    const t = typeof g.payload?.groundType === "string" ? (g.payload.groundType as string) : null;
    if (t && !grounds.includes(t)) grounds.push(t);
  }
  const cls = plan?.metadata && typeof plan.metadata.regulatory_classification === "object" ? (plan.metadata.regulatory_classification as Record<string, unknown> | null) : null;
  return {
    plan: plan ? { id: plan.id, planName: plan.plan_name, insurerName: plan.insurer_name, planType: plan.plan_type, state: plan.state, employerName: plan.employer_name, groupNumber: plan.group_number, classification: cls } : null,
    claim: {
      claimNumber: claim?.claim_number ?? null,
      provider: ((meta.provider as { name?: string } | undefined)?.name) ?? null,
      insurer: ((meta.insurer as { name?: string } | undefined)?.name) ?? null,
      dateOfService: claim?.date_of_service ?? null,
      totalBilled: claim?.total_billed ?? null,
      patientResponsibility: claim?.total_patient_responsibility ?? null,
      inCollections: !!meta.collector,
    },
    grounds,
    documents: ((docs ?? []) as Array<{ id: string; file_name: string | null; doc_type: string | null; classified_type: string | null; created_at: string | null }>).map((d) => ({ id: d.id, fileName: d.file_name, docType: d.doc_type, classifiedType: d.classified_type, createdAt: d.created_at })),
  };
}

export async function loadMatterSummary(
  supabase: SupabaseClient,
  engagement: DfyEngagementRow,
  opts: { now?: Date; users?: Map<string, UserDisplay> } = {},
): Promise<MatterSummary> {
  const now = opts.now ?? new Date();
  const member = engagement.user_id;
  const [composition, insurerLetter, events, profile, users, paperwork] = await Promise.all([
    loadCompositionProof(supabase, member, engagement.claim_id),
    loadInsurerLetter(supabase, member, engagement.claim_id),
    loadDfyEvents(supabase, member, engagement.claim_id),
    userScoped(supabase, member).table("profiles").select("state").maybeSingle(),
    opts.users ?? loadUsersDisplay(supabase, [member, ...(engagement.operator_user_id ? [engagement.operator_user_id] : [])]),
    loadPaperwork(supabase, member, engagement.claim_id),
  ]);
  // S331 — the signed, plan-facing paper the operator submits with the appeal.
  const submittablePaper = await loadSubmittablePaper(supabase, member, engagement.consent_event_ids ?? {});
  const runwayBusinessDays = await computeRunway(supabase, insurerLetter, now);
  const acts = events.filter((e) => e.kind in ACT_PHASE);
  const lastAct = acts.length ? acts[acts.length - 1] : null;
  const memberDisplay = users.get(member) ?? { userId: member, displayName: null, email: null };
  const holder = engagement.operator_user_id
    ? (users.get(engagement.operator_user_id) ?? { userId: engagement.operator_user_id, displayName: null, email: null })
    : null;
  return {
    engagement,
    paperwork,
    submittablePaper,
    member: { ...memberDisplay, state: ((profile.data as { state?: string | null } | null)?.state ?? engagement.member_state) ?? null },
    holder,
    composition,
    insurerLetter,
    runwayBusinessDays,
    events,
    lastAct,
    phase: derivePhase(engagement, composition, lastAct),
  };
}
