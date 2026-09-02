import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped, type DirectUserOwnedTable } from "./user-scoped";
import {
  ACTIONABLE_STATUSES,
  isEngagementStatus,
  type EngagementStatus,
} from "@/lib/dfy/engagement-state";

/**
 * operatorScoped — the DFY grant primitive (handoff §3), a SIBLING of
 * userScoped / adminScoped. NOT adminScoped: an operator does not act by
 * authority over every user; they act under ONE member's signed engagement
 * grant, on ONE claim, and only while they HOLD the matter.
 *
 * Every read/write the operator makes therefore flows through
 * `userScoped(<the member>)` — ownership is the member's, injected by
 * construction — and is further narrowed to the engagement's claim wherever
 * the table carries a claim column. Fail-closed at every step:
 *   - the caller must hold the operator role (or admin — same permissions on
 *     this section, Andrew S330 decision 3; the record still names the actor)
 *   - the engagement must exist and be in an allowed status (default: active)
 *   - the caller must be the holder (operator_user_id) unless the route is the
 *     claim/release mechanic itself
 *   - only the tables an operator legitimately touches are reachable; upsert
 *     is not granted at all
 *
 * The evidentiary trail is the asset: nothing here is a convenience wrapper.
 */

export type EngagementPayer = "member_paid" | "sponsor_paid";
export type OperatorRole = "operator" | "admin";

export interface DfyEngagementRow {
  id: string;
  user_id: string;
  claim_id: string;
  status: EngagementStatus;
  lane: "insurer";
  payer: EngagementPayer;
  sponsor_ref: string | null;
  /** The resolved dfy_sponsors row (paper before code); sponsor_ref keeps the code as typed. */
  sponsor_id: string | null;
  operator_user_id: string | null;
  member_state: string | null;
  plan_classification: Record<string, unknown> | null;
  scope: Record<string, unknown>;
  intake: Record<string, unknown>;
  consent_event_ids: Record<string, unknown>;
  metadata: Record<string, unknown>;
  signed_at: string | null;
  activated_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export const DFY_ENGAGEMENT_COLUMNS =
  "id, user_id, claim_id, status, lane, payer, sponsor_ref, sponsor_id, operator_user_id, member_state, plan_classification, scope, intake, consent_event_ids, metadata, signed_at, activated_at, closed_at, created_at, updated_at";

export class OperatorAccessError extends Error {
  readonly status: 401 | 403 | 404 | 409;
  readonly code: string;
  constructor(status: 401 | 403 | 404 | 409, code: string, message: string) {
    super(message);
    this.name = "OperatorAccessError";
    this.status = status;
    this.code = code;
  }
}

/**
 * The tables an operator may reach under a grant, and the column that pins
 * each to the engagement's CLAIM. `null` = member-scoped only (the member's
 * profile, plan and documents have no claim column). A table absent from this
 * map is unreachable through the grant — fail closed.
 */
export const OPERATOR_TABLE_CLAIM_COLUMN = {
  claims: "id",
  dispute_outcomes: "claim_id",
  claim_case_events: "claim_id",
  claim_discrepancies: "claim_id",
  profiles: null,
  insurance_plans: null,
  documents: null,
} as const satisfies Partial<Record<DirectUserOwnedTable, string | null>>;

export type OperatorTable = keyof typeof OPERATOR_TABLE_CLAIM_COLUMN;

function assertId(value: string, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OperatorAccessError(403, "bad_id", `operatorScoped: ${what} must be a non-empty string (fail-closed)`);
  }
  return value;
}

/** The caller's role on the DFY section — operator, admin, or refused. */
export async function assertOperatorRole(
  supabase: SupabaseClient,
  callerUserId: string,
): Promise<OperatorRole> {
  const uid = assertId(callerUserId, "callerUserId");
  const { data } = await supabase
    .from("users")
    .select("is_operator, is_admin")
    .eq("id", uid)
    .maybeSingle();
  const row = data as { is_operator?: boolean; is_admin?: boolean } | null;
  if (row?.is_operator === true) return "operator";
  if (row?.is_admin === true) return "admin";
  throw new OperatorAccessError(403, "not_operator", "operatorScoped: caller holds neither the operator nor the admin role (fail-closed)");
}

export function parseEngagementRow(raw: unknown): DfyEngagementRow | null {
  const r = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
  if (!r || typeof r.id !== "string" || typeof r.user_id !== "string" || typeof r.claim_id !== "string") return null;
  if (!isEngagementStatus(r.status)) return null;
  const payer = r.payer === "sponsor_paid" ? "sponsor_paid" : "member_paid";
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  return {
    id: r.id,
    user_id: r.user_id,
    claim_id: r.claim_id,
    status: r.status,
    lane: "insurer",
    payer,
    sponsor_ref: typeof r.sponsor_ref === "string" ? r.sponsor_ref : null,
    sponsor_id: typeof r.sponsor_id === "string" ? r.sponsor_id : null,
    operator_user_id: typeof r.operator_user_id === "string" ? r.operator_user_id : null,
    member_state: typeof r.member_state === "string" ? r.member_state : null,
    plan_classification: r.plan_classification && typeof r.plan_classification === "object" ? (r.plan_classification as Record<string, unknown>) : null,
    scope: obj(r.scope),
    intake: obj(r.intake),
    consent_event_ids: obj(r.consent_event_ids),
    metadata: obj(r.metadata),
    signed_at: typeof r.signed_at === "string" ? r.signed_at : null,
    activated_at: typeof r.activated_at === "string" ? r.activated_at : null,
    closed_at: typeof r.closed_at === "string" ? r.closed_at : null,
    created_at: typeof r.created_at === "string" ? r.created_at : "",
    updated_at: typeof r.updated_at === "string" ? r.updated_at : "",
  };
}

/** Load one engagement by id (any status). The raw `.from()` lives HERE, inside the security layer. */
export async function loadEngagement(
  supabase: SupabaseClient,
  engagementId: string,
): Promise<DfyEngagementRow | null> {
  const { data } = await supabase
    .from("dfy_engagements")
    .select(DFY_ENGAGEMENT_COLUMNS)
    .eq("id", assertId(engagementId, "engagementId"))
    .maybeSingle();
  return parseEngagementRow(data);
}

/**
 * The queue read: every engagement, by ROLE authority (the queue is
 * cross-member by design — unclaimed matters are visible to every operator).
 * Returns engagement rows ONLY, never member tables.
 */
export async function listEngagementsForOperators(
  supabase: SupabaseClient,
  callerUserId: string,
): Promise<DfyEngagementRow[]> {
  await assertOperatorRole(supabase, callerUserId);
  const { data } = await supabase
    .from("dfy_engagements")
    .select(DFY_ENGAGEMENT_COLUMNS)
    .order("created_at", { ascending: true });
  return ((data ?? []) as unknown[]).map(parseEngagementRow).filter((r): r is DfyEngagementRow => r !== null);
}

/**
 * Sponsor report rows — (status, determination) ONLY, for the k-anonymous
 * aggregate a sponsor may see. Deliberately NOT the engagement row: no member
 * id, no claim id, no dates. Admin-only at the route; the builder folds any
 * cell under k into "other" (sponsors.ts).
 */
export async function listSponsorReportRows(
  supabase: SupabaseClient,
  sponsorId: string,
): Promise<Array<{ status: string; determination: string | null }>> {
  const { data } = await supabase
    .from("dfy_engagements")
    .select("status, metadata")
    .eq("sponsor_id", assertId(sponsorId, "sponsorId"));
  return ((data ?? []) as Array<{ status: string; metadata: Record<string, unknown> | null }>).map((r) => ({
    status: r.status,
    determination: ((r.metadata?.determination as { determination?: string } | undefined)?.determination) ?? null,
  }));
}

/** Live matters counted against the per-operator cap (signed + active, held by this operator). */
export async function countHeldMatters(
  supabase: SupabaseClient,
  operatorUserId: string,
  countedStatuses: readonly EngagementStatus[],
): Promise<number> {
  const { count } = await supabase
    .from("dfy_engagements")
    .select("id", { count: "exact", head: true })
    .eq("operator_user_id", assertId(operatorUserId, "operatorUserId"))
    .in("status", [...countedStatuses]);
  return count ?? 0;
}

type MemberTable = ReturnType<ReturnType<typeof userScoped>["table"]>;

export interface OperatorScope {
  engagement: DfyEngagementRow;
  role: OperatorRole;
  callerUserId: string;
  /** Member-owned + claim-narrowed access to a granted table. */
  table(table: OperatorTable): Pick<MemberTable, "select" | "update" | "delete" | "insert">;
}

export interface OperatorScopeOptions {
  /** Statuses under which the grant is usable. Default: ACTIONABLE_STATUSES (active). */
  statuses?: readonly EngagementStatus[];
  /** Require the caller to be the holder (operator_user_id). Default true.
   *  The claim/release mechanic itself passes false. */
  requireHolder?: boolean;
}

export async function operatorScoped(
  supabase: SupabaseClient,
  callerUserId: string,
  engagementId: string,
  opts: OperatorScopeOptions = {},
): Promise<OperatorScope> {
  const uid = assertId(callerUserId, "callerUserId");
  const role = await assertOperatorRole(supabase, uid);
  const engagement = await loadEngagement(supabase, engagementId);
  if (!engagement) {
    throw new OperatorAccessError(404, "engagement_not_found", "operatorScoped: engagement not found");
  }
  const statuses = opts.statuses ?? ACTIONABLE_STATUSES;
  if (!statuses.includes(engagement.status)) {
    throw new OperatorAccessError(
      409,
      "engagement_not_actionable",
      `operatorScoped: engagement is ${engagement.status}; allowed: ${statuses.join(", ")}`,
    );
  }
  if (opts.requireHolder !== false && engagement.operator_user_id !== uid) {
    throw new OperatorAccessError(
      403,
      "not_holder",
      engagement.operator_user_id
        ? "operatorScoped: another operator holds this matter"
        : "operatorScoped: this matter is unclaimed — claim it first",
    );
  }
  const member = userScoped(supabase, engagement.user_id);
  return {
    engagement,
    role,
    callerUserId: uid,
    table(table: OperatorTable) {
      if (!(table in OPERATOR_TABLE_CLAIM_COLUMN)) {
        throw new OperatorAccessError(403, "table_not_granted", `operatorScoped: "${table}" is not reachable under an engagement grant`);
      }
      const claimCol = OPERATOR_TABLE_CLAIM_COLUMN[table];
      const base = member.table(table);
      if (claimCol === null) return base;
      const claimId = engagement.claim_id;
      return {
        select(columns = "*", options?: Parameters<MemberTable["select"]>[1]) {
          return base.select(columns, options).eq(claimCol, claimId);
        },
        update(values: Record<string, unknown>) {
          return base.update(values).eq(claimCol, claimId);
        },
        delete() {
          return base.delete().eq(claimCol, claimId);
        },
        insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
          if (claimCol !== "claim_id") {
            throw new OperatorAccessError(403, "insert_not_granted", `operatorScoped: inserts into "${table}" are not granted`);
          }
          const stamped = Array.isArray(rows)
            ? rows.map((r) => ({ ...r, claim_id: claimId }))
            : { ...rows, claim_id: claimId };
          return base.insert(stamped);
        },
      } as Pick<MemberTable, "select" | "update" | "delete" | "insert">;
    },
  };
}

// ── Engagement writers — the ONLY writers of dfy_engagements (S330). ─────────
// Every write re-checks the precondition it depends on in the WHERE clause, so
// two operators racing (claim vs claim, screen vs terminate) cannot both win:
// a zero-row update is the loser's signal, surfaced as a 409.

export interface EngagementPatch {
  status?: EngagementStatus;
  operator_user_id?: string | null;
  intake?: Record<string, unknown>;
  /** The classification snapshot — set at creation from the plan, or by an operator reading the documents at intake. */
  plan_classification?: Record<string, unknown> | null;
  scope?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  consent_event_ids?: Record<string, unknown>;
  signed_at?: string | null;
  activated_at?: string | null;
  closed_at?: string | null;
}

/**
 * Conditional patch: applies only while the row still matches `expect`.
 * Returns the updated row, or null when the precondition no longer held.
 */
export async function patchEngagement(
  supabase: SupabaseClient,
  engagementId: string,
  expect: { status?: EngagementStatus; operator_user_id?: string | null },
  patch: EngagementPatch,
): Promise<DfyEngagementRow | null> {
  let q = supabase
    .from("dfy_engagements")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", assertId(engagementId, "engagementId"));
  if (expect.status !== undefined) q = q.eq("status", expect.status);
  if (expect.operator_user_id !== undefined) {
    q = expect.operator_user_id === null ? q.is("operator_user_id", null) : q.eq("operator_user_id", expect.operator_user_id);
  }
  const { data, error } = await q.select(DFY_ENGAGEMENT_COLUMNS).maybeSingle();
  if (error) {
    console.error("[operator-scoped] patchEngagement failed:", error);
    return null;
  }
  return parseEngagementRow(data);
}

/**
 * The claim mechanic: stamp the caller as holder of an UNCLAIMED live matter.
 * Cap is enforced by the caller (config-backed) BEFORE this runs; this write
 * only ever wins if nobody else claimed first.
 */
export async function claimEngagement(
  supabase: SupabaseClient,
  callerUserId: string,
  engagementId: string,
): Promise<DfyEngagementRow | null> {
  return patchEngagement(
    supabase,
    engagementId,
    { operator_user_id: null },
    { operator_user_id: assertId(callerUserId, "callerUserId") },
  );
}

/** Release: only the holder may release. */
export async function releaseEngagement(
  supabase: SupabaseClient,
  callerUserId: string,
  engagementId: string,
): Promise<DfyEngagementRow | null> {
  return patchEngagement(
    supabase,
    engagementId,
    { operator_user_id: assertId(callerUserId, "callerUserId") },
    { operator_user_id: null },
  );
}

/**
 * Create the grant row for a member + claim (the invitation-only intake entry).
 * Ownership is the MEMBER's — written through userScoped so `user_id` is
 * stamped by construction; the caller has already verified the claim is the
 * member's own. One live engagement per claim is enforced by the partial
 * unique index (a second insert fails with 23505 → the route answers 409).
 */
export async function createEngagement(
  supabase: SupabaseClient,
  memberUserId: string,
  row: {
    claim_id: string;
    payer: EngagementPayer;
    sponsor_ref: string | null;
    sponsor_id?: string | null;
    member_state: string | null;
    plan_classification: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
  },
): Promise<{ engagement: DfyEngagementRow | null; conflict: boolean }> {
  const { data, error } = await userScoped(supabase, memberUserId)
    .table("dfy_engagements")
    .insert({
      claim_id: row.claim_id,
      status: "eligibility_pending",
      lane: "insurer",
      payer: row.payer,
      sponsor_ref: row.sponsor_ref,
      sponsor_id: row.sponsor_id ?? null,
      member_state: row.member_state,
      plan_classification: row.plan_classification,
      metadata: row.metadata ?? {},
    })
    .select(DFY_ENGAGEMENT_COLUMNS)
    .maybeSingle();
  if (error) {
    if (error.code === "23505") return { engagement: null, conflict: true };
    console.error("[operator-scoped] createEngagement failed:", error);
    return { engagement: null, conflict: false };
  }
  return { engagement: parseEngagementRow(data), conflict: false };
}
