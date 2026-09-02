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
}

export interface DfyEventSummary {
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

export interface MatterSummary {
  engagement: DfyEngagementRow;
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
    .select(CASE_TIMELINE_DISPUTE_COLUMNS)
    .eq("claim_id", claimId)
    .order("created_at", { ascending: false });
  const rows = ((data ?? []) as unknown[]) as ProjectorDisputeRow[];
  for (const d of rows) {
    if (d.status === "cancelled") continue;
    const letterType = resolveLetterType(d);
    if (!APPEAL_TYPES.has(letterType)) continue;
    const meta = (d.metadata ?? {}) as Record<string, unknown>;
    return {
      disputeId: d.id,
      letterType,
      status: d.status,
      sentAt: d.sent_at ?? null,
      governingDeadlineDate: d.governing_deadline_date ?? null,
      deadlineType: d.deadline_type ?? null,
      denialNoticeDate: typeof meta.denialNoticeDate === "string" ? meta.denialNoticeDate : null,
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
    .select("kind, dispute_id, occurred_at, payload")
    .eq("claim_id", claimId)
    .like("kind", "dfy_%")
    .order("occurred_at", { ascending: true });
  return ((data ?? []) as Array<{ kind: string; dispute_id: string | null; occurred_at: string; payload: Record<string, unknown> | null }>).map(
    (e) => ({ kind: e.kind, occurredAt: e.occurred_at, disputeId: e.dispute_id ?? null, payload: e.payload ?? {} }),
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

export async function loadMatterSummary(
  supabase: SupabaseClient,
  engagement: DfyEngagementRow,
  opts: { now?: Date; users?: Map<string, UserDisplay> } = {},
): Promise<MatterSummary> {
  const now = opts.now ?? new Date();
  const member = engagement.user_id;
  const [composition, insurerLetter, events, profile, users] = await Promise.all([
    loadCompositionProof(supabase, member, engagement.claim_id),
    loadInsurerLetter(supabase, member, engagement.claim_id),
    loadDfyEvents(supabase, member, engagement.claim_id),
    userScoped(supabase, member).table("profiles").select("state").maybeSingle(),
    opts.users ?? loadUsersDisplay(supabase, [member, ...(engagement.operator_user_id ? [engagement.operator_user_id] : [])]),
  ]);
  const runwayBusinessDays = await computeRunway(supabase, insurerLetter, now);
  const acts = events.filter((e) => e.kind in ACT_PHASE);
  const lastAct = acts.length ? acts[acts.length - 1] : null;
  const memberDisplay = users.get(member) ?? { userId: member, displayName: null, email: null };
  const holder = engagement.operator_user_id
    ? (users.get(engagement.operator_user_id) ?? { userId: engagement.operator_user_id, displayName: null, email: null })
    : null;
  return {
    engagement,
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
