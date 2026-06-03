/**
 * CF-40 v4 (Ing-D.0d) — shared idempotent writer for canonical_divergence_review.
 *
 * TWO Layer-4-ish surfaces route a dissenting per-field value to the admin queue:
 *   - Layer 3(b) minority router (doctype-promotion-aggregator.ts) — the
 *     supermajority's dropped non-baseline tuples. Fires on EVERY parse event with a
 *     vote split (high frequency at scale).
 *   - Layer 4 rapid-change admin-review (invalidation.ts) — a converging challenger
 *     at cold-start / diversity-unmeasurable scale. Fires rarely.
 *
 * Both MUST be idempotent: the parse pipeline RETRIES events, and concurrent QStash
 * workers parse the same popular plan in parallel, so a naive insert duplicates the
 * pending row for the same (canonical, doc_type, field, value). Idempotency is
 * DB-enforced by the partial unique index (mig 142):
 *
 *   UNIQUE (canonical_plan_id, document_type, field_name, minority_value_key)
 *     WHERE status = 'pending'
 *
 * We INSERT and, on the 23505 unique-violation (a pending row already exists for this
 * exact divergence), UPDATE that row in place (weight/users/value grow as more uploads
 * converge). This is race-safe (one worker wins the insert, the other 23505s →
 * refreshes) and retry-safe — unlike read-then-insert, which races. We do NOT use
 * PostgREST .upsert(): it cannot infer a PARTIAL unique index as the conflict arbiter.
 *
 * The WHERE status='pending' scope means a divergence whose prior row was already
 * disposed (confirmed/rejected/deferred) opens a FRESH pending row when it re-emerges
 * (the admin sees it resurfaced) rather than silently reopening a closed disposition.
 *
 * Non-fatal by construction: returns an outcome string; never throws into the caller
 * (which is itself inside recordParseEventV4's best-effort Layer-3/4 try blocks).
 */

import type { createServerClient } from "@/lib/supabase/server";

type SupabaseClient = ReturnType<typeof createServerClient>;

/** canonical_divergence_review.divergence_type CHECK values (mig 086). */
export type DivergenceType =
  | "possible_plan_variant"
  | "possible_adversarial"
  | "possible_stale_doc"
  | "possible_haiku_noise"
  | "unclassified";

export interface DivergenceReviewRow {
  canonicalPlanId: string;
  documentType: string;
  fieldName: string;
  /** Stable text key for the dissenting value — '∅' for null, else String(value).
   *  The idempotency arbiter component (mig 142 partial-unique index). */
  minorityValueKey: string;
  /** Full JSONB context for the admin (value + baseline + plausibility + tuple). */
  minorityValueJsonb: Record<string, unknown>;
  minorityWeight: number;
  totalWeight: number;
  contributingUserIds: string[];
  divergenceType: DivergenceType;
}

export type DivergenceUpsertOutcome = "inserted" | "refreshed" | "skipped";

/**
 * Idempotent insert-or-refresh of one pending divergence-review row. See module
 * header for the race/retry reasoning. Never throws — returns "skipped" on any
 * non-23505 error so the caller's telemetry can note it without aborting the parse.
 */
export async function upsertDivergenceReview(
  supabase: SupabaseClient,
  row: DivergenceReviewRow,
): Promise<DivergenceUpsertOutcome> {
  const insertRes = await supabase.from("canonical_divergence_review").insert({
    canonical_plan_id: row.canonicalPlanId,
    document_type: row.documentType,
    field_name: row.fieldName,
    minority_value_key: row.minorityValueKey,
    minority_value_jsonb: row.minorityValueJsonb,
    minority_weight: row.minorityWeight,
    total_weight: row.totalWeight,
    contributing_user_ids: row.contributingUserIds,
    divergence_type: row.divergenceType,
    status: "pending",
  });

  if (!insertRes.error) return "inserted";

  // 23505 = unique_violation → a PENDING row already exists for this exact
  // (canonical, doc_type, field, value). Refresh it in place rather than duplicate.
  if (insertRes.error.code === "23505") {
    const upd = await supabase
      .from("canonical_divergence_review")
      .update({
        minority_value_jsonb: row.minorityValueJsonb,
        minority_weight: row.minorityWeight,
        total_weight: row.totalWeight,
        contributing_user_ids: row.contributingUserIds,
        updated_at: new Date().toISOString(),
      })
      .eq("canonical_plan_id", row.canonicalPlanId)
      .eq("document_type", row.documentType)
      .eq("field_name", row.fieldName)
      .eq("minority_value_key", row.minorityValueKey)
      .eq("status", "pending");
    return upd.error ? "skipped" : "refreshed";
  }

  // Any other error (e.g. FK, transient) → non-fatal skip; caller notes it.
  return "skipped";
}
