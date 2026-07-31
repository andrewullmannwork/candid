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
  /**
   * S140 — cite-grade citation source for telemetry. 'per_line_sum' = aggregate
   * cited per-line evidence directly; 'claim_header' = aggregate fell back to
   * claim-header totals (Haiku per-line sparsity). Persisted to
   * dispute_outcomes.metadata.citation_source — sole signal for backend B-4
   * "when can we remove Path B fallback?" trigger query.
   */
  citationSource?: "per_line_sum" | "claim_header";
  /**
   * The dispute's EXPLICIT user override — the insurance_plans id the user
   * deliberately chose for this dispute via the "which plan were you on?"
   * chooser (passed from /generate). Persisted to
   * dispute_outcomes.insurance_plan_id; the resolver honors a non-null value
   * above the claim's DOS-correct plan. Written ONLY on explicit user choice —
   * never auto-seeded from the resolved plan. Applied on INSERT only — a dedup
   * re-draft keeps the existing value, never silently overwriting it.
   */
  insurancePlanId?: string | null;
  /**
   * §18 incr-4 Call B (dispute_grounds_v1) — when true, `amountDisputed` is the
   * DEDUCTIBLE-AWARE capped recovery, so a dedup re-draft FLOATS the headline to it
   * (retires the only-increase max-merge — the deterministic engine eliminates the
   * re-parse noise the merge protected against) for UNSENT disputes, and FREEZES it
   * once sent (`sent_at != null`). Undefined/false → the legacy max-merge (byte-identical).
   */
  floatAmountDisputed?: boolean;
  /**
   * dispute-letters v2 S4 — the deadline & follow-up engine's computed governing deadline
   * (dispute_outcomes.governing_deadline_date + deadline_type). Passed ONLY when
   * dispute_deadline_engine_v1 is ON, so the two additive columns are never REFERENCED while
   * the flag is OFF (safe to deploy before mig 196 is applied). Written on INSERT only — a
   * dedup re-draft keeps the existing value (set-once: never move a started clock), exactly
   * like insurancePlanId.
   */
  deadline?: { governingDeadlineDate: string | null; deadlineType: string | null };
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

/** Statuses that mean a dispute is closed — they don't block a fresh row. */
const RESOLVED_STATUSES = [
  "won",
  "lost",
  "settled",
  "withdrawn",
  "won_on_escalation",
  "settled_on_escalation",
];

/**
 * Create or update a dispute_outcomes row when a dispute letter is generated.
 *
 * Dedup key: (user_id, claim_line_item_id, dispute_type) among non-resolved rows.
 * A second draft for the same line item updates letter_content + max(amount_disputed)
 * on the existing row instead of creating a duplicate. Resolved disputes
 * (won/lost/settled/withdrawn/*_on_escalation) don't block a new row — the user
 * may legitimately open a fresh fight after a prior one closed.
 *
 * When claim_line_item_id is null the dedup key is incomplete, so we fall
 * through to INSERT (no safe way to tell two disputes apart).
 */
export async function persistDisputeLetter(
  supabase: SupabaseClient,
  input: PersistDisputeInput
): Promise<{ disputeId: string; deduplicated: boolean } | null> {
  try {
    const disputeType = mapLetterTypeToDisputeType(input.letterType);
    const primaryLineItemId = input.claimLineItemIds?.[0] || null;

    if (primaryLineItemId) {
      const { data: existing, error: selectError } = await supabase
        .from("dispute_outcomes")
        .select("id, amount_disputed, sent_at")
        .eq("user_id", input.userId)
        .eq("claim_line_item_id", primaryLineItemId)
        .eq("dispute_type", disputeType)
        .not("status", "in", `(${RESOLVED_STATUSES.join(",")})`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (selectError) {
        console.error("[disputes-persist] Dedup lookup failed (falling through to insert):", selectError);
      } else if (existing) {
        // §18 incr-4 Call B — float to the deductible-aware amount for UNSENT disputes (frozen
        // at send: a sent dispute keeps its headline); legacy only-increase max-merge when the
        // caller didn't opt in (flag OFF → byte-identical).
        const existingAmount = Number(existing.amount_disputed) || 0;
        const mergedAmount = input.floatAmountDisputed
          ? existing.sent_at != null
            ? existingAmount
            : input.amountDisputed
          : Math.max(existingAmount, input.amountDisputed);
        const { error: updateError } = await supabase
          .from("dispute_outcomes")
          .update({
            letter_content: input.letterContent ?? null,
            amount_disputed: mergedAmount,
            updated_at: new Date().toISOString(),
            metadata: {
              letterType: input.letterType,
              claimLineItemIds: input.claimLineItemIds || [],
              // S140 telemetry — citation_source captured per re-draft so we
              // see how many re-drafts still hit header-fallback over time.
              ...(input.citationSource
                ? { citation_source: input.citationSource }
                : {}),
            },
          })
          .eq("id", existing.id);

        if (updateError) {
          console.error("[disputes-persist] Dedup update failed:", updateError);
          return null;
        }

        console.log(`[disputes-persist] Deduplicated dispute ${existing.id}: type=${input.letterType}, amount=$${mergedAmount}`);
        return { disputeId: existing.id, deduplicated: true };
      }
    }

    // dispute-letters v2 S4 — capture the filed date once so the graduated follow-up letters
    // reference the same "[parent letter] of [date]" this row records.
    const filedDate = new Date().toISOString().split("T")[0];
    const { data, error } = await supabase
      .from("dispute_outcomes")
      .insert({
        user_id: input.userId,
        claim_id: input.claimId || null,
        claim_line_item_id: primaryLineItemId,
        // dispute_plan_pinning_v1 — pin the dispute to its resolved plan (null
        // when the flag is OFF, leaving today's behavior unchanged).
        insurance_plan_id: input.insurancePlanId ?? null,
        dispute_type: disputeType,
        status: "dispute_letter_drafted",
        amount_disputed: input.amountDisputed,
        amount_recovered: 0,
        filed_date: filedDate,
        insurer_id: input.insurerId || null,
        concept_id: input.conceptId || null,
        letter_content: input.letterContent || null,
        metadata: {
          letterType: input.letterType,
          claimLineItemIds: input.claimLineItemIds || [],
          // S140 telemetry — citation_source on initial INSERT. Query via:
          //   SELECT metadata->>'citation_source' AS source, COUNT(*) FROM
          //   dispute_outcomes WHERE created_at > NOW() - INTERVAL '30 days'
          //   GROUP BY 1;
          // Goal: 'claim_header' rate <1% sustained 14d post-backend B-1.
          ...(input.citationSource
            ? { citation_source: input.citationSource }
            : {}),
        },
        // dispute-letters v2 S4 — INSERT-only governing deadline (map §3). Spread only when the
        // engine flag is ON (input.deadline present), so these columns are never REFERENCED while
        // dispute_deadline_engine_v1 is OFF (safe before mig 196 is applied). Preserved on a dedup
        // re-draft (the dedup UPDATE never touches them → set-once), like insurance_plan_id.
        ...(input.deadline
          ? {
              governing_deadline_date: input.deadline.governingDeadlineDate,
              deadline_type: input.deadline.deadlineType,
            }
          : {}),
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("[disputes-persist] Failed to persist dispute:", error);
      return null;
    }

    console.log(`[disputes-persist] Created dispute ${data.id}: type=${input.letterType}, amount=$${input.amountDisputed}`);

    // Create follow-up reminders (feature-flagged). Skipped on dedup UPDATE —
    // a follow-up already exists from the first draft.
    try {
      const { isFeatureEnabled } = await import("@/lib/config/product-flags");
      const followupsEnabled = await isFeatureEnabled("dispute_feedback_loop");
      if (followupsEnabled) {
        const { createFollowups } = await import("@/lib/disputes/followups");
        await createFollowups(supabase, {
          disputeId: data.id,
          userId: input.userId,
          letterType: input.letterType,
          filedDate,
          deadline: input.deadline,
        });
      }
    } catch (err) {
      console.error("[disputes-persist] Follow-up creation failed (non-fatal):", err);
    }

    return { disputeId: data.id, deduplicated: false };
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

    // If dispute is resolved, cancel pending follow-ups + run Pattern 1 #13
    // outlier evaluation + update accuracy scoring.
    if (RESOLVED_STATUSES.includes(update.status)) {
      try {
        await supabase
          .from("dispute_followups")
          .update({ status: "dismissed", updated_at: new Date().toISOString() })
          .eq("dispute_id", disputeId)
          .eq("status", "pending");
      } catch {
        // Non-blocking
      }

      // T2.2 v3: Pattern 1 #13 outlier evaluation on amount_recovered
      // (per [[Candid_Data_Principles]] §6 #13 + Q-T2.2-8 LOCK).
      // Runs BEFORE accuracy scoring so quarantined rows are flagged in time
      // for accuracy.ts to skip them per Q-T2.2-12 LOCK reality-reconciled.
      if (update.amountRecovered !== undefined && update.amountRecovered > 0) {
        try {
          const { evaluateOutlier } = await import("@/lib/disputes/outlier-eval");
          await evaluateOutlier(supabase, {
            disputeId,
            amountRecovered: update.amountRecovered,
          });
        } catch (err) {
          console.error("[disputes-persist] Outlier evaluation failed (non-fatal):", err);
        }
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
    // Guided Steps v1 (S297) — sent-letter card state on /claim. responseDueDate
    // mirrors the dispute page's derivation: governing deadline, else sent + 30d.
    sentAt: string | null;
    responseDueDate: string | null;
  }>;
  totalRecovered: number;
  activeCount: number;
}> {
  const { data: disputes } = await supabase
    .from("dispute_outcomes")
    .select("id, dispute_type, status, amount_disputed, amount_recovered, filed_date, resolution_date, claim_id, sent_at, governing_deadline_date")
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
      sentAt: (d.sent_at as string | null) ?? null,
      responseDueDate: ((): string | null => {
        const governing = (d.governing_deadline_date as string | null) ?? null;
        if (governing) return governing;
        const sent = (d.sent_at as string | null) ?? null;
        if (!sent) return null;
        const t = Date.parse(sent);
        if (Number.isNaN(t)) return null;
        return new Date(t + 30 * 86_400_000).toISOString().slice(0, 10);
      })(),
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
    case "negotiation": return "negotiation";
    case "final_notice": return "complaint";
    case "external_review": return "external_appeal";
    case "debt_validation": return "debt_validation";
    default: {
      // Exhaustiveness guard — a new DisputeLetterType must declare its dispute_type here
      // rather than silently persisting "negotiation" (dispute-letters v2 S2 hardening).
      const _exhaustive: never = letterType;
      return _exhaustive;
    }
  }
}
