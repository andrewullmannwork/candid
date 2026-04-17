/**
 * Dispute Metrics — user + aggregate success rates.
 *
 * getUserDisputeMetrics: personal dispute history stats
 * getAggregateMetrics: cross-user success rates (k-anonymity >= 5)
 * getDisputeSuccessProbability: success rate for a specific rule+insurer+service
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const K_ANONYMITY_THRESHOLD = 5;

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

export interface AggregateMetrics {
  insurerMetrics: Array<{
    insurerName: string;
    totalDisputes: number;
    winRate: number;
    avgRecoveredPct: number | null;
    totalRecovered: number;
  }>;
  overallWinRate: number | null;
  overallRecovered: number;
}

export interface SuccessProbability {
  probability: number | null;
  sampleSize: number;
  sufficient: boolean;
}

export async function getUserDisputeMetrics(
  supabase: SupabaseClient,
  userId: string
): Promise<UserDisputeMetrics> {
  const { data: disputes } = await supabase
    .from("dispute_outcomes")
    .select("status, amount_disputed, amount_recovered")
    .eq("user_id", userId);

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
  const active = disputes.filter((d) => d.status === "filed" || d.status === "in_progress");
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

export async function getAggregateMetrics(
  supabase: SupabaseClient
): Promise<AggregateMetrics> {
  const { data: rows } = await supabase
    .from("audit_rule_accuracy")
    .select("insurer_name, total_disputes, won_count, settled_count, lost_count, total_recovered, avg_recovered_pct");

  if (!rows || rows.length === 0) {
    return { insurerMetrics: [], overallWinRate: null, overallRecovered: 0 };
  }

  // Group by insurer
  const byInsurer = new Map<string, { total: number; wins: number; recovered: number; pct: number | null }>();
  let overallTotal = 0;
  let overallWins = 0;
  let overallRecovered = 0;

  for (const row of rows) {
    if (!row.insurer_name) continue;

    const prev = byInsurer.get(row.insurer_name) || { total: 0, wins: 0, recovered: 0, pct: null };
    prev.total += row.total_disputes;
    prev.wins += row.won_count + row.settled_count;
    prev.recovered += row.total_recovered;
    prev.pct = row.avg_recovered_pct;
    byInsurer.set(row.insurer_name, prev);

    overallTotal += row.total_disputes;
    overallWins += row.won_count + row.settled_count;
    overallRecovered += row.total_recovered;
  }

  // k-anonymity filter
  const insurerMetrics = Array.from(byInsurer.entries())
    .filter(([, v]) => v.total >= K_ANONYMITY_THRESHOLD)
    .map(([name, v]) => ({
      insurerName: name,
      totalDisputes: v.total,
      winRate: v.total > 0 ? v.wins / v.total : 0,
      avgRecoveredPct: v.pct,
      totalRecovered: v.recovered,
    }))
    .sort((a, b) => b.totalDisputes - a.totalDisputes);

  return {
    insurerMetrics,
    overallWinRate: overallTotal >= K_ANONYMITY_THRESHOLD ? overallWins / overallTotal : null,
    overallRecovered,
  };
}

/**
 * Get success probability for a specific rule type + insurer + service.
 * Returns null if insufficient data (k-anonymity).
 */
export async function getDisputeSuccessProbability(
  supabase: SupabaseClient,
  ruleType: string,
  insurerName?: string,
  serviceSlug?: string
): Promise<SuccessProbability> {
  let query = supabase
    .from("audit_rule_accuracy")
    .select("total_disputes, won_count, settled_count, lost_count")
    .eq("rule_type", ruleType);

  if (insurerName) query = query.eq("insurer_name", insurerName);
  if (serviceSlug) query = query.eq("service_slug", serviceSlug);

  const { data: rows } = await query;

  if (!rows || rows.length === 0) {
    return { probability: null, sampleSize: 0, sufficient: false };
  }

  const total = rows.reduce((s, r) => s + r.total_disputes, 0);
  const wins = rows.reduce((s, r) => s + r.won_count + r.settled_count, 0);

  return {
    probability: total > 0 ? wins / total : null,
    sampleSize: total,
    sufficient: total >= K_ANONYMITY_THRESHOLD,
  };
}
