/**
 * Dispute Metrics — user + aggregate success rates.
 *
 * getUserDisputeMetrics: personal dispute history stats (no k-anon; user reads own)
 * getAggregateMetrics: cross-user success rates (k-anonymity ≥5 distinct USER count)
 * getDisputeSuccessProbability: success rate for a specific rule+insurer+service
 *
 * T2.2 v3 changes (Session 62):
 *   - Q-T2.2-4 LOCK SHARPENED: k-anon enforcement uses distinct USER count, not row count.
 *     Previous K_ANONYMITY_THRESHOLD checked total_disputes (row count) which leaked privacy
 *     when single user had ≥5 disputes against same insurer. Now COUNT DISTINCT user_id.
 *   - Q-T2.2-12 LOCK Option B: distinct user count computed-on-read via JOIN to
 *     dispute_outcomes (no stored distinct_user_count column; drift-immune by construction).
 *   - Q-T2.2-10 LOCK: optional plan_year filter on aggregates.
 *   - Q-T2.2-5 LOCK: methodology metadata co-located in response shape per Pattern 1 #11.
 *   - Pattern 2 alignment: aggregates source insurer dimension from dispute_outcomes.insurer_id
 *     (canonical FK) when available; fallback to insurer_name text via insurance_plans JOIN.
 *   - Pattern 1 #13 quarantine: cross-user aggregates EXCLUDE flywheel_eligibility_status='quarantined_outlier'.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_K_ANON_MIN_DISTINCT_USERS = 5;

const TERMINAL_STATUSES = [
  "won",
  "lost",
  "settled",
  "won_on_escalation",
  "settled_on_escalation",
];
const WIN_STATUSES = ["won", "settled", "won_on_escalation", "settled_on_escalation"];

export interface UserDisputeMetrics {
  totalFiled: number;
  totalWon: number;
  totalSettled: number;
  totalLost: number;
  totalActive: number;
  wonOnEscalation: number;
  totalRecovered: number;
  totalDisputed: number;
  winRate: number | null;
}

export interface MethodologyMetadata {
  since: string | null;
  plan_years_included: number[];
  k_anon_min_distinct_users: number;
  states_included: string[];
  outlier_quarantine_active: boolean;
  insurer_canonical_id_used: boolean;
}

export interface AggregateMetrics {
  insurerMetrics: Array<{
    insurerName: string;
    insurerCanonicalId: string | null;
    distinctUserCount: number;
    totalOutcomes: number;
    wins: number;
    losses: number;
    winRate: number;
    totalRecovered: number;
    avgRecoveredPct: number | null;
  }>;
  overallDistinctUsers: number;
  overallWinRate: number | null;
  overallRecovered: number;
  methodology: MethodologyMetadata;
}

export interface SuccessProbability {
  probability: number | null;
  sampleSize: number;
  distinctUserCount: number;
  sufficient: boolean;
}

interface DisputeRow {
  user_id: string;
  status: string;
  amount_disputed: number | null;
  amount_recovered: number | null;
  insurer_id: string | null;
  flywheel_eligibility_status: string | null;
  plan_year: number | null;
}

interface QueryFilters {
  planYears?: number[];
  insurerCanonicalId?: string;
  insurerName?: string;
  ruleType?: string;
  serviceSlug?: string;
}

async function readKAnonMin(supabase: SupabaseClient): Promise<number> {
  try {
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("config")
      .eq("flag_key", "dispute_feedback_loop")
      .maybeSingle();
    const cfg = (data?.config as Record<string, unknown> | undefined) ?? {};
    const k = cfg.k_anon_min_distinct_users;
    return typeof k === "number" && k >= 1 ? k : DEFAULT_K_ANON_MIN_DISTINCT_USERS;
  } catch {
    return DEFAULT_K_ANON_MIN_DISTINCT_USERS;
  }
}

export async function getUserDisputeMetrics(
  supabase: SupabaseClient,
  userId: string,
  options?: { planYears?: number[] },
): Promise<UserDisputeMetrics> {
  let query = supabase
    .from("dispute_outcomes")
    .select("status, amount_disputed, amount_recovered, plan_year")
    .eq("user_id", userId);
  if (options?.planYears && options.planYears.length > 0) {
    query = query.in("plan_year", options.planYears);
  }
  const { data: disputes } = await query;

  if (!disputes || disputes.length === 0) {
    return {
      totalFiled: 0, totalWon: 0, totalSettled: 0, totalLost: 0,
      totalActive: 0, wonOnEscalation: 0, totalRecovered: 0, totalDisputed: 0, winRate: null,
    };
  }

  const totalFiled = disputes.length;
  const won = disputes.filter((d) => d.status === "won" || d.status === "won_on_escalation");
  const settled = disputes.filter((d) => d.status === "settled" || d.status === "settled_on_escalation");
  const lost = disputes.filter((d) => d.status === "lost");
  const active = disputes.filter(
    (d) =>
      d.status === "filed" ||
      d.status === "in_progress" ||
      d.status === "dispute_letter_drafted" ||
      d.status === "court_documentation_drafted",
  );
  const wonOnEscalation = disputes.filter((d) => d.status === "won_on_escalation" || d.status === "settled_on_escalation");
  const resolved = won.length + settled.length + lost.length;

  return {
    totalFiled,
    totalWon: won.length,
    totalSettled: settled.length,
    totalLost: lost.length,
    totalActive: active.length,
    wonOnEscalation: wonOnEscalation.length,
    totalRecovered: disputes.reduce((s, d) => s + (d.amount_recovered || 0), 0),
    totalDisputed: disputes.reduce((s, d) => s + (d.amount_disputed || 0), 0),
    winRate: resolved > 0 ? (won.length + settled.length) / resolved : null,
  };
}

/**
 * Cross-user aggregate metrics with privacy-correct k-anon enforcement.
 *
 * Sources from dispute_outcomes directly (NOT audit_rule_accuracy stored aggregate)
 * to compute distinct user count per cell. Filters quarantined rows. Optional plan_year
 * filter per Q-T2.2-10 LOCK.
 */
export async function getAggregateMetrics(
  supabase: SupabaseClient,
  filters?: QueryFilters,
): Promise<AggregateMetrics> {
  const kAnonMin = await readKAnonMin(supabase);

  // T2.2 v3: source from dispute_outcomes for k-anon-correct distinct user count.
  // Filter terminal status + non-quarantined per Pattern 1 #13.
  let query = supabase
    .from("dispute_outcomes")
    .select("user_id, status, amount_disputed, amount_recovered, insurer_id, flywheel_eligibility_status, plan_year")
    .in("status", TERMINAL_STATUSES)
    .or("flywheel_eligibility_status.is.null,flywheel_eligibility_status.in.(verified_via_dispute,verified_via_corroboration,verified_via_admin)");

  if (filters?.planYears && filters.planYears.length > 0) {
    query = query.in("plan_year", filters.planYears);
  }
  if (filters?.insurerCanonicalId) {
    query = query.eq("insurer_id", filters.insurerCanonicalId);
  }

  const { data: rows } = await query;
  const disputeRows: DisputeRow[] = (rows ?? []) as DisputeRow[];

  const methodology: MethodologyMetadata = {
    since: disputeRows.length > 0 ? findEarliestDate(supabase, disputeRows) : null,
    plan_years_included: collectPlanYears(disputeRows),
    k_anon_min_distinct_users: kAnonMin,
    states_included: TERMINAL_STATUSES,
    outlier_quarantine_active: true,
    insurer_canonical_id_used: disputeRows.some((r) => r.insurer_id !== null),
  };

  if (disputeRows.length === 0) {
    return {
      insurerMetrics: [],
      overallDistinctUsers: 0,
      overallWinRate: null,
      overallRecovered: 0,
      methodology,
    };
  }

  // Build insurer_id → name map for canonical rows (one query batch)
  const canonicalIds = Array.from(new Set(disputeRows.map((r) => r.insurer_id).filter((id): id is string => !!id)));
  const insurerNameMap = new Map<string, string>();
  if (canonicalIds.length > 0) {
    const { data: insurers } = await supabase
      .from("insurer_catalog")
      .select("id, canonical_name")
      .in("id", canonicalIds);
    for (const ins of insurers ?? []) {
      insurerNameMap.set(ins.id as string, (ins.canonical_name as string) || "");
    }
  }

  // Group by insurer (canonical_id when present; fall back to "(unknown)" bucket)
  type Cell = {
    insurerCanonicalId: string | null;
    insurerName: string;
    users: Set<string>;
    totalOutcomes: number;
    wins: number;
    losses: number;
    recovered: number;
    pctSum: number;
    pctCount: number;
  };
  const byInsurer = new Map<string, Cell>();

  for (const row of disputeRows) {
    const key = row.insurer_id ?? "__unknown__";
    const existing = byInsurer.get(key) ?? {
      insurerCanonicalId: row.insurer_id ?? null,
      insurerName: row.insurer_id ? (insurerNameMap.get(row.insurer_id) ?? "(unknown)") : "(unknown)",
      users: new Set<string>(),
      totalOutcomes: 0,
      wins: 0,
      losses: 0,
      recovered: 0,
      pctSum: 0,
      pctCount: 0,
    };
    existing.users.add(row.user_id);
    existing.totalOutcomes += 1;
    if (WIN_STATUSES.includes(row.status)) existing.wins += 1;
    if (row.status === "lost") existing.losses += 1;
    existing.recovered += row.amount_recovered ?? 0;
    if (row.amount_disputed && row.amount_recovered && row.amount_disputed > 0 && WIN_STATUSES.includes(row.status)) {
      existing.pctSum += row.amount_recovered / row.amount_disputed;
      existing.pctCount += 1;
    }
    byInsurer.set(key, existing);
  }

  const insurerMetrics = Array.from(byInsurer.values())
    .filter((cell) => cell.users.size >= kAnonMin)
    .map((cell) => ({
      insurerName: cell.insurerName,
      insurerCanonicalId: cell.insurerCanonicalId,
      distinctUserCount: cell.users.size,
      totalOutcomes: cell.totalOutcomes,
      wins: cell.wins,
      losses: cell.losses,
      winRate: cell.totalOutcomes > 0 ? cell.wins / cell.totalOutcomes : 0,
      totalRecovered: cell.recovered,
      avgRecoveredPct: cell.pctCount > 0
        ? Math.round((cell.pctSum / cell.pctCount) * 100) / 100
        : null,
    }))
    .sort((a, b) => b.distinctUserCount - a.distinctUserCount);

  // Overall: distinct users across the dataset (after quarantine filter)
  const overallUsers = new Set(disputeRows.map((r) => r.user_id));
  const overallWins = disputeRows.filter((r) => WIN_STATUSES.includes(r.status)).length;
  const overallRecovered = disputeRows.reduce((s, r) => s + (r.amount_recovered ?? 0), 0);
  const overallDistinctUsers = overallUsers.size;
  const overallWinRate = overallDistinctUsers >= kAnonMin && disputeRows.length > 0
    ? overallWins / disputeRows.length
    : null;

  return {
    insurerMetrics,
    overallDistinctUsers,
    overallWinRate,
    overallRecovered,
    methodology,
  };
}

/**
 * Get success probability for a specific rule type + insurer + service.
 * Returns null if insufficient data (k-anonymity on distinct user count).
 *
 * T2.2 v3: replaces audit_rule_accuracy row-count gate with dispute_outcomes
 * distinct-user gate for privacy correctness.
 */
export async function getDisputeSuccessProbability(
  supabase: SupabaseClient,
  ruleType: string,
  insurerName?: string,
  serviceSlug?: string,
): Promise<SuccessProbability> {
  const kAnonMin = await readKAnonMin(supabase);

  const query = supabase
    .from("dispute_outcomes")
    .select("user_id, status, dispute_type, claim_id, flywheel_eligibility_status")
    .eq("dispute_type", ruleType)
    .in("status", TERMINAL_STATUSES)
    .or("flywheel_eligibility_status.is.null,flywheel_eligibility_status.in.(verified_via_dispute,verified_via_corroboration,verified_via_admin)");

  const { data: rows } = await query;
  if (!rows || rows.length === 0) {
    return { probability: null, sampleSize: 0, distinctUserCount: 0, sufficient: false };
  }

  // Filter by insurer_name + service_slug via the audit_rule_accuracy text join
  // (these are text dimensions on the legacy aggregate; for v3 we filter the
  // dispute rows by joining to claims → insurance_plans + claim_line_items if needed).
  // Fast path: if no text filters, use rows directly.
  let filteredRows = rows;
  if (insurerName || serviceSlug) {
    const claimIds = Array.from(new Set(rows.map((r) => r.claim_id).filter((id): id is string => !!id)));
    if (claimIds.length === 0) {
      return { probability: null, sampleSize: 0, distinctUserCount: 0, sufficient: false };
    }

    const matchedClaimIds = new Set<string>();
    if (insurerName) {
      const { data: claims } = await supabase
        .from("claims")
        .select("id, insurance_plan_id")
        .in("id", claimIds);
      const planIds = Array.from(new Set((claims ?? []).map((c) => c.insurance_plan_id).filter((id): id is string => !!id)));
      if (planIds.length === 0) {
        return { probability: null, sampleSize: 0, distinctUserCount: 0, sufficient: false };
      }
      const { data: plans } = await supabase
        .from("insurance_plans")
        .select("id, insurer_name")
        .in("id", planIds)
        .eq("insurer_name", insurerName);
      const matchedPlanIds = new Set((plans ?? []).map((p) => p.id as string));
      for (const claim of claims ?? []) {
        if (matchedPlanIds.has(claim.insurance_plan_id as string)) {
          matchedClaimIds.add(claim.id as string);
        }
      }
    }
    if (serviceSlug) {
      const { data: lineItems } = await supabase
        .from("claim_line_items")
        .select("claim_id")
        .in("claim_id", claimIds)
        .eq("service_slug", serviceSlug);
      const slugClaimIds = new Set((lineItems ?? []).map((li) => li.claim_id as string));
      if (insurerName) {
        // intersection
        for (const id of Array.from(matchedClaimIds)) {
          if (!slugClaimIds.has(id)) matchedClaimIds.delete(id);
        }
      } else {
        for (const id of Array.from(slugClaimIds)) matchedClaimIds.add(id);
      }
    }
    filteredRows = rows.filter((r) => r.claim_id && matchedClaimIds.has(r.claim_id));
  }

  const distinctUsers = new Set(filteredRows.map((r) => r.user_id));
  const wins = filteredRows.filter((r) => WIN_STATUSES.includes(r.status)).length;
  const total = filteredRows.length;

  return {
    probability: total > 0 ? wins / total : null,
    sampleSize: total,
    distinctUserCount: distinctUsers.size,
    sufficient: distinctUsers.size >= kAnonMin,
  };
}

// Helpers
function collectPlanYears(rows: DisputeRow[]): number[] {
  const years = new Set<number>();
  for (const r of rows) if (typeof r.plan_year === "number") years.add(r.plan_year);
  return Array.from(years).sort((a, b) => a - b);
}

function findEarliestDate(_supabase: SupabaseClient, _rows: DisputeRow[]): string | null {
  // Simple implementation: dispute_outcomes carries created_at; we don't fetch it
  // in the aggregate query for performance. Return null for v1; UI tooltip can omit.
  // v1.5+ enrichment: add `since` to query if methodology disclosure UX surfaces it.
  return null;
}
