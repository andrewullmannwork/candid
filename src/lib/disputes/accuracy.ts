/**
 * Dispute Accuracy Scoring — tracks success rates per audit rule, insurer, and service.
 *
 * On dispute outcome update: upserts audit_rule_accuracy.
 * Feeds back into audit engine (success probability on findings)
 * and user-facing metrics ("Similar disputes: 73% success rate").
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

  // Fetch dispute context: rule type, insurer, service
  const { data: dispute } = await supabase
    .from("dispute_outcomes")
    .select("dispute_type, amount_disputed, metadata, claim_id")
    .eq("id", disputeId)
    .single();

  if (!dispute) return;

  const ruleType = dispute.dispute_type || "unknown";
  const disputed = amountDisputed ?? dispute.amount_disputed ?? 0;

  // Try to get insurer name and service slug from the linked claim
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

  // Upsert accuracy row
  const recoveredPct = disputed > 0 && amountRecovered
    ? Math.round((amountRecovered / disputed) * 100) / 100
    : null;

  const { data: existing } = await supabase
    .from("audit_rule_accuracy")
    .select("id, total_disputes, won_count, settled_count, lost_count, total_recovered")
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

    await supabase
      .from("audit_rule_accuracy")
      .update({
        total_disputes: newTotal,
        won_count: newWon,
        settled_count: newSettled,
        lost_count: newLost,
        total_recovered: newRecovered,
        avg_recovered_pct: recoveredPct,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
  } else {
    await supabase.from("audit_rule_accuracy").insert({
      rule_type: ruleType,
      insurer_name: insurerName,
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
