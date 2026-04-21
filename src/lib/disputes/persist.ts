/**
 * Dispute Outcome Persistence
 *
 * Saves dispute letters and tracks their outcomes (filed, won, lost, settled).
 * Enables cumulative savings tracking and dispute success rate aggregation
 * across users, services, and insurers.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DisputeLetterType } from "@/lib/billing/types";

export interface PersistDisputeInput {
  userId: string;
  claimId?: string;
  claimLineItemIds?: string[];
  letterType: DisputeLetterType;
  amountDisputed: number;
  insurerId?: string;
  conceptId?: string;
  /** Full letter text so users can revisit what was drafted. */
  letterContent?: string;
}

/**
 * Dispute lifecycle statuses.
 *
 * Additive: the old values (filed, in_progress, won, lost, settled, withdrawn,
 * won_on_escalation, settled_on_escalation) remain valid for legacy rows.
 * New rows created from Session 35 onward should use the new lifecycle
 * vocabulary (dispute_letter_drafted, court_documentation_drafted).
 *
 * Display mapping in `src/app/(app)/claim/page.tsx#STATUS_LABELS`.
 */
export type DisputeStatus =
  // Legacy (still written by some paths; map to new labels at render time)
  | "filed"
  | "in_progress"
  | "won"
  | "lost"
  | "settled"
  | "withdrawn"
  | "won_on_escalation"
  | "settled_on_escalation"
  // New lifecycle (Session 35)
  | "dispute_letter_drafted"
  | "court_documentation_drafted";

export interface DisputeOutcomeUpdate {
  status: DisputeStatus;
  amountRecovered?: number;
  resolutionDate?: string;
  strategyNotes?: string;
  /** When we generate an evidence package, persist it here. */
  evidencePackage?: Record<string, unknown>;
  /** When we draft/regenerate a letter, overwrite it here. */
  letterContent?: string;
}

/**
 * Create a dispute_outcomes row when a dispute letter is generated.
 * Initial status is "filed".
 */
export async function persistDisputeLetter(
  supabase: SupabaseClient,
  input: PersistDisputeInput
): Promise<{ disputeId: string } | null> {
  try {
    const { data, error } = await supabase
      .from("dispute_outcomes")
      .insert({
        user_id: input.userId,
        claim_id: input.claimId || null,
        claim_line_item_id: input.claimLineItemIds?.[0] || null, // Primary line item
        dispute_type: mapLetterTypeToDisputeType(input.letterType),
        status: "dispute_letter_drafted",
        amount_disputed: input.amountDisputed,
        amount_recovered: 0,
        filed_date: new Date().toISOString().split("T")[0],
        insurer_id: input.insurerId || null,
        concept_id: input.conceptId || null,
        letter_content: input.letterContent || null,
        metadata: {
          letterType: input.letterType,
          claimLineItemIds: input.claimLineItemIds || [],
        },
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("[disputes-persist] Failed to persist dispute:", error);
      return null;
    }

    console.log(`[disputes-persist] Created dispute ${data.id}: type=${input.letterType}, amount=$${input.amountDisputed}`);

    // Create follow-up reminders (feature-flagged)
    try {
      const { isFeatureEnabled } = await import("@/lib/config/product-flags");
      const followupsEnabled = await isFeatureEnabled("dispute_feedback_loop");
      if (followupsEnabled) {
        const { createFollowups } = await import("@/lib/disputes/followups");
        await createFollowups(supabase, { disputeId: data.id, userId: input.userId });
      }
    } catch (err) {
      console.error("[disputes-persist] Follow-up creation failed (non-fatal):", err);
    }

    return { disputeId: data.id };
  } catch (err) {
    console.error("[disputes-persist] Error:", err);
    return null;
  }
}

/**
 * Update the outcome of an existing dispute.
 */
export async function updateDisputeOutcome(
  supabase: SupabaseClient,
  disputeId: string,
  update: DisputeOutcomeUpdate
): Promise<boolean> {
  try {
    const updateData: Record<string, unknown> = {
      status: update.status,
    };

    if (update.amountRecovered !== undefined) {
      updateData.amount_recovered = update.amountRecovered;
    }
    if (update.resolutionDate) {
      updateData.resolution_date = update.resolutionDate;
    }
    if (update.strategyNotes) {
      updateData.strategy_notes = update.strategyNotes;
    }
    if (update.evidencePackage !== undefined) {
      updateData.evidence_package = update.evidencePackage;
    }
    if (update.letterContent !== undefined) {
      updateData.letter_content = update.letterContent;
    }

    const { error } = await supabase
      .from("dispute_outcomes")
      .update(updateData)
      .eq("id", disputeId);

    if (error) {
      console.error("[disputes-persist] Failed to update dispute:", error);
      return false;
    }

    // If dispute is resolved, cancel pending follow-ups + update accuracy scoring
    const resolvedStatuses = ["won", "lost", "settled", "withdrawn", "won_on_escalation", "settled_on_escalation"];
    if (resolvedStatuses.includes(update.status)) {
      try {
        await supabase
          .from("dispute_followups")
          .update({ status: "dismissed", updated_at: new Date().toISOString() })
          .eq("dispute_id", disputeId)
          .eq("status", "pending");
      } catch {
        // Non-blocking
      }

      // Update accuracy scoring (non-blocking)
      try {
        const { updateAccuracyScoring } = await import("@/lib/disputes/accuracy");
        await updateAccuracyScoring(supabase, {
          disputeId,
          status: update.status,
          amountRecovered: update.amountRecovered,
        });
      } catch (err) {
        console.error("[disputes-persist] Accuracy scoring failed (non-fatal):", err);
      }
    }

    console.log(`[disputes-persist] Updated dispute ${disputeId}: status=${update.status}${update.amountRecovered ? `, recovered=$${update.amountRecovered}` : ""}`);
    return true;
  } catch (err) {
    console.error("[disputes-persist] Error:", err);
    return false;
  }
}

/**
 * Get user's dispute history with outcomes.
 */
export async function getUserDisputes(
  supabase: SupabaseClient,
  userId: string
): Promise<{
  disputes: Array<{
    id: string;
    disputeType: string;
    status: string;
    amountDisputed: number;
    amountRecovered: number;
    filedDate: string;
    resolutionDate: string | null;
    claimId: string | null;
  }>;
  totalRecovered: number;
  activeCount: number;
}> {
  const { data: disputes } = await supabase
    .from("dispute_outcomes")
    .select("id, dispute_type, status, amount_disputed, amount_recovered, filed_date, resolution_date, claim_id")
    .eq("user_id", userId)
    .order("filed_date", { ascending: false });

  if (!disputes || disputes.length === 0) {
    return { disputes: [], totalRecovered: 0, activeCount: 0 };
  }

  const totalRecovered = disputes.reduce(
    (sum, d) => sum + (d.amount_recovered || 0),
    0
  );
  const activeCount = disputes.filter(
    (d) => d.status === "filed"
      || d.status === "in_progress"
      || d.status === "dispute_letter_drafted"
      || d.status === "court_documentation_drafted"
  ).length;

  return {
    disputes: disputes.map((d) => ({
      id: d.id,
      disputeType: d.dispute_type,
      status: d.status,
      amountDisputed: d.amount_disputed || 0,
      amountRecovered: d.amount_recovered || 0,
      filedDate: d.filed_date,
      resolutionDate: d.resolution_date,
      claimId: d.claim_id,
    })),
    totalRecovered,
    activeCount,
  };
}

function mapLetterTypeToDisputeType(letterType: DisputeLetterType): string {
  switch (letterType) {
    case "insurance_appeal": return "internal_appeal";
    case "overcharge": return "negotiation";
    case "balance_billing": return "complaint";
    case "duplicate_charge": return "internal_appeal";
    case "itemized_request": return "negotiation";
    default: return "negotiation";
  }
}
