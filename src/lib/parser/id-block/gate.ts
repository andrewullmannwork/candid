/**
 * ID-Block — the live corroboration gate (IO orchestrator).
 *
 * Invoked from recordParseEventV4 ONLY when a parse would PROMOTE a doc-type at
 * cold_start/small. Self-contained: it reads the `id_block_corroboration` flag,
 * re-derives the EXACT promoted cluster (the verified users whose latest upload voted
 * the winning tuple — same filters as computeLayer3Inputs: cf40_layer1_passed +
 * email&phone-verified + latest-per-user + identity-tuple match), gathers each
 * member's content fingerprint + §9.1 engagement signals, computes isNovelCanonical
 * (hios_id ∈ plan_catalog OR is_verified ⇒ seeded), and scores via the PURE
 * scoreClusterLegitimacy. The CF-40 aggregator (computeLayer3Inputs/gatherLayer3Inputs)
 * is NOT touched — the hook only reads values it already returns.
 *
 * Flag OFF / out-of-scope / no cluster → returns null (byte-identical promotion).
 * The pure decision (decideQuarantineAction) is fixture-locked (Ship Gate G4).
 *
 * SoT: plans/id-block-corroboration-source-independence.md §3-§5 + §9.3.
 */

import type { createServerClient } from "@/lib/supabase/server";
import {
  ID_BLOCK_FLAG_KEY,
  parseIdBlockConfig,
  type IdBlockConfig,
  type QuarantineMode,
} from "./config";
import { scoreClusterLegitimacy } from "./cluster-legitimacy";
import type { ClusterLegitimacyResult, ClusterMember, UserLegitimacySignals } from "./types";

type SupabaseClient = ReturnType<typeof createServerClient>;
type Row = Record<string, unknown>;
const rows = (d: Row[] | null | undefined): Row[] => d ?? [];

/** ID-Block applies at cold_start/small (§3.4); medium+ has network-diversity (§6). */
const IN_SCOPE_TIERS = new Set(["very_cold_start", "cold_start", "small"]);

/** The supermajority identity scalars — mirrors SUPERMAJORITY_IDENTITY_FIELDS. */
const IDENTITY_FIELDS = [
  "in_deductible_individual",
  "in_deductible_family",
  "in_oop_max_individual",
  "in_oop_max_family",
] as const;

/** Stable key of an identity tuple (NULL distinguished from 0) — mirrors identityKey. */
function tupleKey(t: Record<string, unknown>): string {
  return IDENTITY_FIELDS.map((f) => {
    const v = t[f];
    return v === null || v === undefined ? "∅" : String(v);
  }).join("|");
}

// ── pure decision (fixture-locked) ───────────────────────────────────────────

export interface QuarantineAction {
  /** active mode AND the gate flagged → withhold the promotion. */
  hold: boolean;
  /** the quarantine row state. */
  state: "shadow" | "held";
  /** fire a Slack alert (every would-flag, shadow OR active). */
  slackWorthy: boolean;
}

export function decideQuarantineAction(
  result: ClusterLegitimacyResult,
  mode: QuarantineMode,
): QuarantineAction {
  const slackWorthy = result.wouldFlag;
  const hold = mode === "active" && result.wouldFlag;
  return { hold, state: hold ? "held" : "shadow", slackWorthy };
}

// ── outcome ──────────────────────────────────────────────────────────────────

export interface IdBlockGateOutcome {
  result: ClusterLegitimacyResult;
  mode: QuarantineMode;
  action: QuarantineAction;
  clusterUserIds: string[];
  contentFingerprints: string[];
  valueTupleJsonb: Record<string, unknown>;
  valueTupleKey: string;
  scaleTier: string;
  isNovelCanonical: boolean;
}

interface ClusterRow {
  userId: string;
  planId: string;
  uploadedAt: string;
  accountCreatedAt: string;
  fingerprint: string | null;
}

export interface IdBlockGateArgs {
  canonicalPlanId: string;
  docType: string;
  /** the promoted (supermajority winner) identity tuple — the 4 cost scalars. */
  baselineTuple: Record<string, number | null> | null;
  scaleTier: string;
}

/**
 * Run the gate. Returns null when it does not apply (flag OFF, out-of-scope tier, no
 * verified same-tuple cluster) — the caller proceeds with byte-identical promotion.
 */
export async function evaluateIdBlockGate(
  supabase: SupabaseClient,
  args: IdBlockGateArgs,
): Promise<IdBlockGateOutcome | null> {
  if (!args.baselineTuple) return null;
  if (!IN_SCOPE_TIERS.has(args.scaleTier)) return null;

  // Flag read (enabled gates the run; config carries the thresholds). Read failure →
  // do NOT run (byte-identical) — the gate is never the reason a parse breaks.
  let cfg: IdBlockConfig;
  try {
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("enabled, config")
      .eq("flag_key", ID_BLOCK_FLAG_KEY)
      .maybeSingle();
    if (data?.enabled !== true) return null;
    cfg = parseIdBlockConfig((data as { config?: unknown }).config ?? null);
  } catch {
    return null;
  }

  return gatherAndScoreCluster(supabase, args, cfg);
}

/**
 * The gather + score + decide, WITHOUT the flag read. Split out so the read-only
 * shadow dry-run (validation) can exercise the REAL gate code over real promoted
 * canonicals before the flag/table exist. Returns null when there is no verified
 * same-tuple cluster of ≥2 to corroborate.
 */
export async function gatherAndScoreCluster(
  supabase: SupabaseClient,
  args: IdBlockGateArgs,
  cfg: IdBlockConfig,
): Promise<IdBlockGateOutcome | null> {
  const { canonicalPlanId, docType, baselineTuple, scaleTier } = args;
  if (!baselineTuple) return null;

  const cluster = await gatherBaselineCluster(supabase, canonicalPlanId, docType, baselineTuple);
  if (cluster.length < 2) return null; // nothing to corroborate

  const signalsByUser = await gatherEngagement(supabase, cluster.map((c) => c.userId));
  const isNovelCanonical = await computeIsNovelCanonical(supabase, canonicalPlanId);

  const members: ClusterMember[] = cluster.map((c) => ({
    signals: signalsByUser.get(c.userId) ?? thinSignals(c.userId),
    contentFingerprint: c.fingerprint,
    uploadedAt: c.uploadedAt,
    accountCreatedAt: c.accountCreatedAt,
  }));

  const result = scoreClusterLegitimacy(members, { isNovelCanonical }, cfg);
  const action = decideQuarantineAction(result, cfg.gate.mode);

  return {
    result,
    mode: cfg.gate.mode,
    action,
    clusterUserIds: cluster.map((c) => c.userId),
    contentFingerprints: cluster.map((c) => c.fingerprint).filter((f): f is string => !!f),
    valueTupleJsonb: { ...baselineTuple },
    valueTupleKey: tupleKey(baselineTuple),
    scaleTier,
    isNovelCanonical,
  };
}

// ── self-gather: the exact promoted cluster ──────────────────────────────────

async function gatherBaselineCluster(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  docType: string,
  baselineTuple: Record<string, unknown>,
): Promise<ClusterRow[]> {
  const { data: planRows } = await supabase
    .from("insurance_plans")
    .select(
      "id, user_id, created_at, in_deductible_individual, in_deductible_family, in_oop_max_individual, in_oop_max_family",
    )
    .eq("canonical_plan_id", canonicalPlanId);
  const prs = rows(planRows);
  if (prs.length === 0) return [];
  const planIds = prs.map((r) => r.id as string);

  // documents → fingerprint per plan, filtered to docType + Layer-1-passed (mirrors gather).
  const { data: docs } = await supabase
    .from("documents")
    .select("linked_insurance_plan_id, classified_type, cf40_layer1_passed, content_fingerprint")
    .in("linked_insurance_plan_id", planIds);
  const fpByPlan = new Map<string, string | null>();
  for (const d of rows(docs)) {
    const pid = d.linked_insurance_plan_id as string | null;
    if (
      pid &&
      d.cf40_layer1_passed === true &&
      d.classified_type === docType &&
      !fpByPlan.has(pid)
    ) {
      fpByPlan.set(pid, (d.content_fingerprint as string | null) ?? null);
    }
  }
  const filtered = prs.filter((r) => fpByPlan.has(r.id as string));
  if (filtered.length === 0) return [];

  const userIds = [...new Set(filtered.map((r) => r.user_id as string))];
  const { data: users } = await supabase
    .from("users")
    .select("id, email_verified, phone_verified, created_at")
    .in("id", userIds);
  const userById = new Map(rows(users).map((u) => [u.id as string, u]));
  const isVerified = (uid: string): boolean => {
    const u = userById.get(uid);
    return !!u && u.email_verified === true && u.phone_verified === true;
  };

  // latest-per-user verified row.
  const latestByUser = new Map<string, Row>();
  for (const r of filtered) {
    const uid = r.user_id as string;
    if (!isVerified(uid)) continue;
    const prev = latestByUser.get(uid);
    if (!prev || new Date(r.created_at as string) > new Date(prev.created_at as string)) {
      latestByUser.set(uid, r);
    }
  }

  // keep the users whose winning row matches the promoted (baseline) tuple.
  const bKey = tupleKey(baselineTuple);
  const cluster: ClusterRow[] = [];
  for (const [uid, r] of latestByUser) {
    if (tupleKey(r) !== bKey) continue;
    const u = userById.get(uid);
    cluster.push({
      userId: uid,
      planId: r.id as string,
      uploadedAt: r.created_at as string,
      accountCreatedAt: (u?.created_at as string | null) ?? (r.created_at as string),
      fingerprint: fpByPlan.get(r.id as string) ?? null,
    });
  }
  return cluster;
}

// ── §9.1 engagement signals per cluster user (batched) ───────────────────────

function thinSignals(userId: string): UserLegitimacySignals {
  return {
    userId,
    hasClaimsWithEob: false,
    hasActiveSubscription: false,
    hasInsuranceCard: false,
    accountAgeDays: 0,
    signupToUploadLatencyDays: 0,
    activityBreadth: 0,
    profileCompleteness: 0,
  };
}

/**
 * Exported (PR3a) so the read-only admin work-list scores each cluster user with the
 * EXACT signals the live gate uses — the §4.1 legitimacy sub-score the admin sees is
 * never a parallel re-implementation. The raw §4.1 display breakdown (broken-out
 * counts, profile-field presence, this-upload doc + sensor) is NOT produced here — the
 * gate does not consume it — it is gathered separately in inventory.ts.
 */
export async function gatherEngagement(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Map<string, UserLegitimacySignals>> {
  const out = new Map<string, UserLegitimacySignals>();
  if (userIds.length === 0) return out;
  const now = Date.now();
  const dayDiff = (fromIso: string | null, toMs: number): number =>
    fromIso ? Math.max(0, (toMs - new Date(fromIso).getTime()) / 86_400_000) : 0;

  const [usersRes, subsRes, docsRes, claimsRes, plansRes, disputesRes, profsRes] =
    await Promise.all([
      supabase.from("users").select("id, created_at, display_name").in("id", userIds),
      supabase.from("stripe_customers").select("user_id, subscription_status").in("user_id", userIds),
      supabase.from("documents").select("id, user_id, classified_type").in("user_id", userIds),
      supabase.from("claims").select("user_id, source_document_id").in("user_id", userIds),
      supabase.from("insurance_plans").select("user_id, created_at, employer_name").in("user_id", userIds),
      supabase.from("dispute_outcomes").select("user_id").in("user_id", userIds),
      supabase
        .from("profiles")
        .select("user_id, date_of_birth, state, address, county, sex, dependents")
        .in("user_id", userIds),
    ]);

  const userById = new Map(rows(usersRes.data as Row[]).map((u) => [u.id as string, u]));
  const subByUser = new Map(
    rows(subsRes.data as Row[]).map((s) => [s.user_id as string, s.subscription_status as string]),
  );
  const docTypesByUser = new Map<string, Set<string>>();
  const eobIdsByUser = new Map<string, Set<string>>();
  const cardUsers = new Set<string>();
  for (const d of rows(docsRes.data as Row[])) {
    const uid = d.user_id as string;
    const ct = (d.classified_type as string | null) ?? "";
    if (!docTypesByUser.has(uid)) docTypesByUser.set(uid, new Set());
    docTypesByUser.get(uid)!.add(ct);
    if (ct === "insurance_card") cardUsers.add(uid);
    if (ct === "eob") {
      if (!eobIdsByUser.has(uid)) eobIdsByUser.set(uid, new Set());
      eobIdsByUser.get(uid)!.add(d.id as string);
    }
  }
  const eobClaimUsers = new Set<string>();
  for (const c of rows(claimsRes.data as Row[])) {
    const uid = c.user_id as string;
    const sid = c.source_document_id as string | null;
    if (sid && eobIdsByUser.get(uid)?.has(sid)) eobClaimUsers.add(uid);
  }
  const earliestPlan = new Map<string, string>();
  const employerUsers = new Set<string>();
  const planCount = new Map<string, number>();
  for (const p of rows(plansRes.data as Row[])) {
    const uid = p.user_id as string;
    planCount.set(uid, (planCount.get(uid) ?? 0) + 1);
    if (p.employer_name) employerUsers.add(uid);
    const ca = p.created_at as string;
    if (!earliestPlan.has(uid) || new Date(ca) < new Date(earliestPlan.get(uid)!)) {
      earliestPlan.set(uid, ca);
    }
  }
  const disputeCount = new Map<string, number>();
  for (const d of rows(disputesRes.data as Row[])) {
    const uid = d.user_id as string;
    disputeCount.set(uid, (disputeCount.get(uid) ?? 0) + 1);
  }
  const profByUser = new Map(rows(profsRes.data as Row[]).map((p) => [p.user_id as string, p]));

  for (const uid of userIds) {
    const u = userById.get(uid);
    const prof = profByUser.get(uid);
    const profFields = [
      u?.display_name,
      employerUsers.has(uid) ? "x" : null,
      prof?.date_of_birth,
      prof?.state,
      prof?.address,
      prof?.county,
      prof?.sex,
      prof?.dependents,
    ];
    const profileCompleteness =
      profFields.filter((f) => f !== null && f !== undefined && f !== "").length / profFields.length;
    const sub = subByUser.get(uid);
    const accountCreated = (u?.created_at as string | null) ?? null;
    out.set(uid, {
      userId: uid,
      hasClaimsWithEob: eobClaimUsers.has(uid),
      hasActiveSubscription: sub === "active" || sub === "trialing",
      hasInsuranceCard: cardUsers.has(uid),
      accountAgeDays: dayDiff(accountCreated, now),
      signupToUploadLatencyDays: dayDiff(
        accountCreated,
        new Date(earliestPlan.get(uid) ?? new Date(now).toISOString()).getTime(),
      ),
      activityBreadth:
        (docTypesByUser.get(uid)?.size ?? 0) + (disputeCount.get(uid) ?? 0) + (planCount.get(uid) ?? 0),
      profileCompleteness,
    });
  }
  return out;
}

// ── isNovelCanonical: hios_id ∈ plan_catalog (CMS registry) OR is_verified ⇒ seeded ─

async function computeIsNovelCanonical(
  supabase: SupabaseClient,
  canonicalPlanId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("canonical_plans")
    .select("hios_id, is_verified")
    .eq("id", canonicalPlanId)
    .maybeSingle();
  if (!data) return true; // unknown → conservatively novel (higher scrutiny)
  if ((data as { is_verified?: unknown }).is_verified === true) return false; // admin-blessed
  const hios = (data as { hios_id?: string | null }).hios_id;
  if (!hios) return true; // no federal id → no authoritative seed
  const { data: pc } = await supabase
    .from("plan_catalog")
    .select("hios_id")
    .eq("hios_id", hios)
    .limit(1)
    .maybeSingle();
  return !pc; // present in the CMS registry ⇒ seeded ⇒ not novel
}
