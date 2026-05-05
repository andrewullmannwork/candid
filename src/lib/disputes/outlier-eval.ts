/**
 * Pattern 1 #13 Outlier Evaluation for Dispute Outcomes (T2.2 v3)
 *
 * On terminal-state outcome submission with amount_recovered populated, evaluates
 * whether the recovery is statistically outlier per Q-T2.2-8 LOCK:
 *   - Threshold: amount_recovered ≥ outlier_threshold_usd (default $100K)
 *   - Multiplier: amount_recovered > outlier_multiplier × amount_disputed (default 10×)
 *
 * If either trigger fires → set flywheel_eligibility_status='quarantined_outlier'
 * → row excluded from cross-user aggregates per Pattern 1 #13 quarantine state machine.
 *
 * Thresholds + multiplier read from dispute_feedback_loop.config JSONB (admin-tunable).
 *
 * See [[Candid_Data_Principles]] §6 #13 + memory project_candid_outlier_quarantine.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

interface OutlierEvalParams {
  disputeId: string;
  amountRecovered: number;
}

interface OutlierConfig {
  threshold_usd: number;
  multiplier: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: OutlierConfig = {
  threshold_usd: 100000,
  multiplier: 10,
  enabled: true,
};

async function readConfig(supabase: SupabaseClient): Promise<OutlierConfig> {
  try {
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("config")
      .eq("flag_key", "dispute_feedback_loop")
      .maybeSingle();

    const cfg = (data?.config as Record<string, unknown> | undefined) ?? {};
    return {
      threshold_usd: typeof cfg.outlier_threshold_usd === "number"
        ? cfg.outlier_threshold_usd
        : DEFAULT_CONFIG.threshold_usd,
      multiplier: typeof cfg.outlier_multiplier === "number"
        ? cfg.outlier_multiplier
        : DEFAULT_CONFIG.multiplier,
      enabled: typeof cfg.outlier_quarantine_enabled === "boolean"
        ? cfg.outlier_quarantine_enabled
        : DEFAULT_CONFIG.enabled,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function evaluateOutlier(
  supabase: SupabaseClient,
  params: OutlierEvalParams,
): Promise<void> {
  const { disputeId, amountRecovered } = params;

  const cfg = await readConfig(supabase);
  if (!cfg.enabled) return;

  const { data: dispute } = await supabase
    .from("dispute_outcomes")
    .select("amount_disputed, insurer_id, claim_id, user_id")
    .eq("id", disputeId)
    .maybeSingle();
  if (!dispute) return;

  const amountDisputed = Number(dispute.amount_disputed) || 0;
  const exceedsThreshold = amountRecovered >= cfg.threshold_usd;
  const exceedsMultiplier =
    amountDisputed > 0 && amountRecovered > cfg.multiplier * amountDisputed;

  if (!exceedsThreshold && !exceedsMultiplier) return;

  const reason = exceedsThreshold
    ? `amount_recovered $${amountRecovered.toLocaleString()} ≥ threshold $${cfg.threshold_usd.toLocaleString()}`
    : `amount_recovered $${amountRecovered.toLocaleString()} > ${cfg.multiplier}× amount_disputed ($${amountDisputed.toLocaleString()})`;

  const { error } = await supabase
    .from("dispute_outcomes")
    .update({
      flywheel_eligibility_status: "quarantined_outlier",
      updated_at: new Date().toISOString(),
    })
    .eq("id", disputeId);

  if (error) {
    console.error("[outlier-eval] Failed to set quarantine status:", error);
    return;
  }

  console.log(`[outlier-eval] Quarantined dispute ${disputeId}: ${reason}`);

  // Slack alert (non-blocking)
  try {
    const { notifyOutlierQuarantine } = await import(
      "@/lib/disputes/followup-notifications"
    );
    await notifyOutlierQuarantine({
      disputeId,
      amountRecovered,
      amountDisputed,
      reason,
    });
  } catch (err) {
    console.error("[outlier-eval] Slack notify failed (non-fatal):", err);
  }
}
