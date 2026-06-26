/**
 * Phase 4 Task 4-B (Session 56) — Consumer-read filter helper module.
 *
 * Provides decoration context + per-field decoration utilities for the
 * `/api/plan/analyze` route handler. When the `consumer_read_filter_v1` feature
 * flag is OFF (default), `loadDecorationContext()` returns null and callers
 * skip decoration entirely (response is byte-identical to pre-Phase-4). When
 * the flag is ON, returns a context object with the corroboration threshold +
 * verification count for canonical-inherited rows, which callers thread into
 * `decorateFieldFromEntry()` from the consumer-read library.
 *
 * SCOPE: this helper handles the API-internal plumbing (flag check, threshold
 * read, canonical-plan source-count fetch). Per-field decoration logic itself
 * lives in `src/lib/parser/consumer-read.ts` (Task 4-A library).
 *
 * WHY a helper module (not inline in route.ts): Tasks 4-D (plan page), 4-D.X
 * (dashboard), and 4-E (EvidenceBlock + PDF letter) all need identical
 * decoration plumbing when their respective routes/components branch on flag
 * state. Centralizing here means one source of truth for "are we decorating
 * right now?" + "what's the corroboration threshold?" rather than each
 * call site re-fetching independently.
 */

import { isFeatureEnabled, readFeatureFlagConfig } from "@/lib/config/product-flags";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Decoration context loaded once per request. Null when the consumer-read
 * filter flag is OFF — callers should branch on null and skip decoration entirely
 * (preserves byte-identical legacy response shape).
 */
export interface DecorationContext {
  /** Pattern 1 #4 multi-source corroboration threshold for canonical-source rows.
   *  Read from `feature_flag_rules.config->>'value'` for `pattern1_corroboration_threshold`.
   *  Default 3 (audit item #4-interim — raised from 2 because P.2 Phone OTP not yet
   *  shipped; email-only identity is gameable for ≥2 distinct users). */
  multiSourceThreshold: number;
  /** Distinct user count with `insurance_plans.canonical_plan_id = userPlan.canonical_plan_id`.
   *  Read directly from `canonical_plans.verification_count` (mig 066) — denormalized integer
   *  maintained by trigger on insurance_plans INSERT/UPDATE/DELETE. Reliability bar:
   *  cannot drift from actual user count under concurrent writes (transactional trigger).
   *  Defaults to 1 when userPlan has no canonical_plan_id (self-source rendering only). */
  canonicalSourceCount: number;
  /** A3 (cite-grade gate): `cite_grade_gate_v1` state, read once per request. Threaded into
   *  `decorateFieldFromEntry` (caps synonym-inferred cells to `estimate`) and read by /compare to
   *  set the `inferred: synonym_cache` marker. Only meaningful while decorating (this whole context
   *  is null when consumer_read_filter_v1 is OFF — no decoration → nothing to cap). Optional so
   *  informational-only fallback constructors (auto-reparse) default to dormant; loadDecorationContext
   *  (the user-facing path) always sets the real flag value. */
  citeGradeGateOn?: boolean;
}

/**
 * Fetch the decoration context if the `consumer_read_filter_v1` flag is ON for
 * this user. Returns null when flag is OFF — callers should skip decoration entirely.
 *
 * NOTE: userEmail is needed because feature flags can use 'users' or 'percentage'
 * targeting modes, both of which require the user identity to evaluate. Pass null
 * if user identity unavailable (admin tool calls, service-to-service); flag falls
 * back to global-only evaluation.
 */
export async function loadDecorationContext(
  supabase: SupabaseClient,
  userEmail: string | null | undefined,
  userPlan: { canonical_plan_id?: string | null } | null | undefined,
): Promise<DecorationContext | null> {
  const flagOn = await isFeatureEnabled("consumer_read_filter_v1", userEmail ?? undefined);
  if (!flagOn) return null;

  const multiSourceThreshold = await readFeatureFlagConfig(
    "pattern1_corroboration_threshold",
    "value",
    3,
  );

  // A3 (cite-grade gate): read once here so every decorate call site (analyze + compare) shares
  // one truth. OFF → identity axis dormant → byte-identical to today's decoration.
  const citeGradeGateOn = await isFeatureEnabled("cite_grade_gate_v1", userEmail ?? undefined);

  let canonicalSourceCount = 1;
  if (userPlan?.canonical_plan_id) {
    const { data: canonicalPlan } = await supabase
      .from("canonical_plans")
      .select("verification_count")
      .eq("id", userPlan.canonical_plan_id)
      .single();
    canonicalSourceCount = canonicalPlan?.verification_count ?? 1;
  }

  return { multiSourceThreshold, canonicalSourceCount, citeGradeGateOn };
}

/**
 * Resolve the logical Pattern 1 source for a benefit row at the API consumer-read layer.
 *
 * Distinguishes three rendering paths:
 *   - "canonical_inherited": canonical gap-fill rows (canonical_plan_services rows
 *     where this user has no plan_covered_services overlay). Subject to multi-source
 *     corroboration threshold.
 *   - "canonical_fallback": county-aware fallback (premium pulled from CMS marketplace
 *     when no SBC/EOC is uploaded). Subject to threshold.
 *   - The row's own `source` (e.g., "doc_extraction", "sbc_parser") for self-source
 *     plan_covered_services rows. Threshold = 0 (self/trusted).
 *
 * Used by Phase 4 Task 4-D + 4-E call sites; 4-B uses it inline in the route handler.
 */
export type LogicalRowSource = "canonical_inherited" | "canonical_fallback" | string;

export function resolveRowSource(opts: {
  isCanonicalGapFill: boolean;
  isCanonicalFallback: boolean;
  rowSource: string | null | undefined;
}): LogicalRowSource {
  if (opts.isCanonicalGapFill) return "canonical_inherited";
  if (opts.isCanonicalFallback) return "canonical_fallback";
  return opts.rowSource ?? "doc_extraction";
}

/**
 * Source count for a row given its logical source category. Self-source rows always
 * report sourceCount=1 (the user's own upload); canonical rows use the verification_count
 * from the decoration context.
 */
export function resolveSourceCount(
  logicalSource: LogicalRowSource,
  context: DecorationContext,
): number {
  if (logicalSource === "canonical_inherited" || logicalSource === "canonical_fallback") {
    return context.canonicalSourceCount;
  }
  return 1;
}
