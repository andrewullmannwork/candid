/**
 * Post-Escalation Follow-up — tracks outcomes after user escalates to Case or small claims.
 *
 * When a user escalates (Candid Case, small claims, external appeal), creates a 60-day
 * follow-up timer. At 60 days: "What's the status of your escalation?"
 *
 * If won/settled: updates original dispute to won_on_escalation/settled_on_escalation.
 * This feeds back into accuracy scoring — the dispute wasn't truly lost, it needed escalation.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createPostEscalationFollowup } from "./followups";

/**
 * Record an escalation and create the post-escalation follow-up.
 */
export async function recordEscalation(
  supabase: SupabaseClient,
  params: {
    disputeId: string;
    userId: string;
    escalationType: "case" | "small_claims" | "external_appeal";
  }
): Promise<void> {
  const { disputeId, userId, escalationType } = params;

  // Update dispute metadata with escalation info
  const { data: dispute } = await supabase
    .from("dispute_outcomes")
    .select("metadata")
    .eq("id", disputeId)
    .single();

  const existingMeta = (dispute?.metadata as Record<string, unknown>) || {};

  await supabase
    .from("dispute_outcomes")
    .update({
      metadata: {
        ...existingMeta,
        escalation: {
          type: escalationType,
          date: new Date().toISOString().split("T")[0],
        },
      },
    })
    .eq("id", disputeId);

  // Create 60-day post-escalation follow-up
  await createPostEscalationFollowup(supabase, {
    disputeId,
    userId,
    escalationType,
  });

  console.log(`[post-escalation] Recorded ${escalationType} escalation for dispute ${disputeId}`);
}

/**
 * Handle a post-escalation outcome.
 * Updates the original dispute status (won_on_escalation, settled_on_escalation)
 * and records the recovery amount.
 */
export async function handlePostEscalationOutcome(
  supabase: SupabaseClient,
  params: {
    disputeId: string;
    outcome: "won" | "settled" | "lost" | "still_ongoing" | "withdrew";
    amountRecovered?: number;
  }
): Promise<void> {
  const { disputeId, outcome, amountRecovered } = params;

  if (outcome === "still_ongoing") {
    // Create another 30-day reprompt
    const { data: dispute } = await supabase
      .from("dispute_outcomes")
      .select("user_id, metadata")
      .eq("id", disputeId)
      .single();

    if (dispute) {
      const escalationType = ((dispute.metadata as Record<string, unknown>)?.escalation as Record<string, unknown>)?.type as string || "case";

      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 30);

      await supabase.from("dispute_followups").insert({
        dispute_id: disputeId,
        user_id: dispute.user_id,
        followup_type: "post_escalation_reprompt_30d",
        due_date: dueDate.toISOString().split("T")[0],
        status: "pending",
        escalation_type: escalationType,
      });
    }
    return;
  }

  if (outcome === "withdrew") {
    // No status change on the dispute — it stays "lost"
    return;
  }

  // Won or settled on escalation — update original dispute
  const newStatus = outcome === "won" ? "won_on_escalation" : "settled_on_escalation";

  const updateData: Record<string, unknown> = {
    status: newStatus,
    resolution_date: new Date().toISOString().split("T")[0],
  };

  if (amountRecovered !== undefined) {
    updateData.amount_recovered = amountRecovered;
  }

  await supabase
    .from("dispute_outcomes")
    .update(updateData)
    .eq("id", disputeId);

  // Cancel remaining follow-ups
  await supabase
    .from("dispute_followups")
    .update({ status: "dismissed", updated_at: new Date().toISOString() })
    .eq("dispute_id", disputeId)
    .eq("status", "pending");

  // Update accuracy scoring
  try {
    const { updateAccuracyScoring } = await import("@/lib/disputes/accuracy");
    await updateAccuracyScoring(supabase, {
      disputeId,
      status: newStatus,
      amountRecovered,
    });
  } catch {
    // Non-blocking
  }

  console.log(`[post-escalation] Dispute ${disputeId} → ${newStatus} (recovered: $${amountRecovered || 0})`);
}
