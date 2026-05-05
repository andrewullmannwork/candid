/**
 * Dispute Accuracy Scoring — tracks success rates per audit rule, insurer, and service.
 *
 * On dispute outcome update: upserts audit_rule_accuracy.
 * Feeds back into audit engine (success probability on findings)
 * and user-facing metrics ("Similar disputes: 73% success rate").
 *
 * T2.2 v3 changes (Session 62):
 *   - SKIP upsert when row is quarantined per Pattern 1 #13 (Q-T2.2-8 LOCK).
 *   - Pattern 2 alignment dual-write: populate insurer_canonical_id (UUID FK) alongside
 *     insurer_name (text) per Q-T2.2-12 LOCK Option C. Reads at metrics.ts prefer
 *     canonical_id JOIN; fallback to text. Existing rows backfill at OPS Sprint
 *     (CF-16b in [[Candid_Todos]]).
 *   - avg_recovered_pct running-average bug fix: previous code overwrote with latest
 *     value; now computes proper running mean over win/settled cohort.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Update accuracy scoring after a dispute outcome is resolved.
 * Called from persist.ts on status change to won/lost/settled/won_on_escalation/settled_on_escalation.
 */
export async function updateAccuracyScoring(
  supabase: SupabaseClient,
  params: {
    disputeId: string;
    status: string;
    amountRecovered?: number;
    amountDisputed?: number;
  }
): Promise<void> {
  const { disputeId, status, amountRecovered, amountDisputed } = params;

  // Determine outcome category
  const isWin = ["won", "settled", "won_on_escalation", "settled_on_escalation"].includes(status);
  const isLoss = status === "lost";
  const isSettled = ["settled", "settled_on_escalation"].includes(status);

  if (!isWin && !isLoss) return;

  // Fetch dispute context: rule type, insurer, service, quarantine status
  // T2.2 v3: include insurer_id (Pattern 2 canonical FK from mig 019) +
  // flywheel_eligibility_status (Pattern 1 #13 from mig 070).
  const { data: dispute } = await supabase
    .from("dispute_outcomes")
    .select("dispute_type, amount_disputed, metadata, claim_id, insurer_id, flywheel_eligibility_status")
    .eq("id", disputeId)
    .single();

  if (!dispute) return;

  // T2.2 v3 Q-T2.2-8 LOCK: skip upsert if quarantined per Pattern 1 #13.
  // Quarantined outcomes don't enter cross-user aggregates.
  if (dispute.flywheel_eligibility_status === "quarantined_outlier") {
    console.log(`[accuracy] Skipped scoring for quarantined dispute ${disputeId}`);
    return;
  }

  const ruleType = dispute.dispute_type || "unknown";
  const disputed = amountDisputed ?? dispute.amount_disputed ?? 0;
  const insurerCanonicalId = dispute.insurer_id ?? null;

  // Try to get insurer name (text fallback) and service slug from the linked claim
  let insurerName = "";
  let serviceSlug = "";

  if (dispute.claim_id) {
    try {
      const { data: claim } = await supabase
        .from("claims")
        .select("insurance_plan_id")
        .eq("id", dispute.claim_id)
        .single();

      if (claim?.insurance_plan_id) {
        const { data: plan } = await supabase
          .from("insurance_plans")
          .select("insurer_name")
          .eq("id", claim.insurance_plan_id)
          .single();
        insurerName = plan?.insurer_name || "";
      }

      // Get primary service slug from the first claim line item
      const claimLineItemId = (dispute.metadata as Record<string, unknown>)?.claimLineItemIds;
      if (Array.isArray(claimLineItemId) && claimLineItemId[0]) {
        const { data: lineItem } = await supabase
          .from("claim_line_items")
          .select("service_slug")
          .eq("id", claimLineItemId[0])
          .single();
        serviceSlug = lineItem?.service_slug || "";
      }
    } catch {
      // Best-effort
    }
  }

  // Per-dispute recovery percentage (used to update running average)
  const recoveredPct = disputed > 0 && amountRecovered
    ? Math.round((amountRecovered / disputed) * 100) / 100
    : null;

  const { data: existing } = await supabase
    .from("audit_rule_accuracy")
    .select("id, total_disputes, won_count, settled_count, lost_count, total_recovered, avg_recovered_pct, insurer_canonical_id")
    .eq("rule_type", ruleType)
    .eq("insurer_name", insurerName)
    .eq("service_slug", serviceSlug)
    .maybeSingle();

  if (existing) {
    const newTotal = existing.total_disputes + 1;
    const newWon = existing.won_count + (isWin && !isSettled ? 1 : 0);
    const newSettled = existing.settled_count + (isSettled ? 1 : 0);
    const newLost = existing.lost_count + (isLoss ? 1 : 0);
    const newRecovered = existing.total_recovered + (amountRecovered || 0);

    // T2.2 v3: avg_recovered_pct running-average fix.
    // Previous code overwrote with latest value; now computes running mean
    // over the win/settled cohort (losses don't contribute since they have no recovery).
    let newAvgPct = existing.avg_recovered_pct;
    if ((isWin || isSettled) && recoveredPct !== null) {
      const prevWinCohort = existing.won_count + existing.settled_count;
      const newWinCohort = newWon + newSettled;
      const prevAvg = existing.avg_recovered_pct ?? 0;
      newAvgPct = newWinCohort > 0
        ? Math.round(((prevAvg * prevWinCohort + recoveredPct) / newWinCohort) * 100) / 100
        : prevAvg;
    }

    // T2.2 v3: dual-write insurer_canonical_id when available; preserve existing
    // canonical_id if already populated (existing rows from prior upserts).
    const updateData: Record<string, unknown> = {
      total_disputes: newTotal,
      won_count: newWon,
      settled_count: newSettled,
      lost_count: newLost,
      total_recovered: newRecovered,
      avg_recovered_pct: newAvgPct,
      updated_at: new Date().toISOString(),
    };
    if (insurerCanonicalId && !existing.insurer_canonical_id) {
      updateData.insurer_canonical_id = insurerCanonicalId;
    }

    await supabase
      .from("audit_rule_accuracy")
      .update(updateData)
      .eq("id", existing.id);
  } else {
    await supabase.from("audit_rule_accuracy").insert({
      rule_type: ruleType,
      insurer_name: insurerName,
      insurer_canonical_id: insurerCanonicalId,
      service_slug: serviceSlug,
      total_disputes: 1,
      won_count: isWin && !isSettled ? 1 : 0,
      settled_count: isSettled ? 1 : 0,
      lost_count: isLoss ? 1 : 0,
      total_recovered: amountRecovered || 0,
      avg_recovered_pct: recoveredPct,
    });
  }

  console.log(`[accuracy] Updated scoring: ${ruleType}/${insurerName}/${serviceSlug} → ${status}`);
}
