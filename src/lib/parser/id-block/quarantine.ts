/**
 * ID-Block — idempotent writer for canonical_promotion_quarantine (mig 158).
 *
 * Mirrors cf40-v4/divergence-review.ts: INSERT, and on the 23505 partial-unique
 * violation (a LIVE shadow|held row already exists for this canonical/doc_type/
 * value-tuple), UPDATE that row in place (the cluster grows as more uploads converge).
 * Race-safe (one worker wins the insert, the other refreshes) and retry-safe — the
 * QStash parse pipeline retries events and parallel workers parse the same plan.
 *
 * Never throws — returns an outcome + the row id (for the Slack dedupe / deep-link).
 * The caller is itself inside recordParseEventV4's best-effort try block.
 *
 * SoT: plans/id-block-corroboration-source-independence.md §9.4.
 */

import type { createServerClient } from "@/lib/supabase/server";

type SupabaseClient = ReturnType<typeof createServerClient>;

export interface QuarantineRow {
  canonicalPlanId: string;
  documentType: string;
  /** stable key of the promoted identity tuple — the idempotency arbiter component. */
  valueTupleKey: string;
  valueTupleJsonb: Record<string, unknown>;
  clusterUserIds: string[];
  /** non-null member fingerprints (text[] NOT NULL column). */
  contentFingerprints: string[];
  clusterScore: number;
  sameContent: boolean;
  novelCanonical: boolean;
  shapeJsonb: Record<string, unknown>;
  triggerReasons: string[];
  scaleTier: string;
  state: "shadow" | "held";
  nextEvalAt: string | null;
}

export type QuarantineOutcome = "inserted" | "refreshed" | "skipped";
export interface QuarantineUpsertResult {
  outcome: QuarantineOutcome;
  id: string | null;
}

export async function upsertPromotionQuarantine(
  supabase: SupabaseClient,
  row: QuarantineRow,
): Promise<QuarantineUpsertResult> {
  const insertRes = await supabase
    .from("canonical_promotion_quarantine")
    .insert({
      canonical_plan_id: row.canonicalPlanId,
      document_type: row.documentType,
      value_tuple_key: row.valueTupleKey,
      value_tuple_jsonb: row.valueTupleJsonb,
      cluster_user_ids: row.clusterUserIds,
      content_fingerprints: row.contentFingerprints,
      cluster_score: row.clusterScore,
      same_content: row.sameContent,
      novel_canonical: row.novelCanonical,
      shape_jsonb: row.shapeJsonb,
      trigger_reasons: row.triggerReasons,
      scale_tier: row.scaleTier,
      state: row.state,
      next_eval_at: row.nextEvalAt,
    })
    .select("id")
    .maybeSingle();

  if (!insertRes.error && insertRes.data) {
    return { outcome: "inserted", id: (insertRes.data as { id: string }).id };
  }

  // 23505 = a LIVE (shadow|held) row already exists for this exact cluster → refresh.
  if (insertRes.error?.code === "23505") {
    const upd = await supabase
      .from("canonical_promotion_quarantine")
      .update({
        value_tuple_jsonb: row.valueTupleJsonb,
        cluster_user_ids: row.clusterUserIds,
        content_fingerprints: row.contentFingerprints,
        cluster_score: row.clusterScore,
        same_content: row.sameContent,
        novel_canonical: row.novelCanonical,
        shape_jsonb: row.shapeJsonb,
        trigger_reasons: row.triggerReasons,
        scale_tier: row.scaleTier,
        state: row.state,
        next_eval_at: row.nextEvalAt,
        updated_at: new Date().toISOString(),
      })
      .eq("canonical_plan_id", row.canonicalPlanId)
      .eq("document_type", row.documentType)
      .eq("value_tuple_key", row.valueTupleKey)
      .in("state", ["shadow", "held"])
      .select("id")
      .maybeSingle();
    return upd.error || !upd.data
      ? { outcome: "skipped", id: null }
      : { outcome: "refreshed", id: (upd.data as { id: string }).id };
  }

  return { outcome: "skipped", id: null };
}
