/**
 * S73.5 D6 — Plan-year-aware document validity window.
 *
 * Replaces the absolute 12-month doc-age gate with a plan-year-aware window
 * per Subplan §2.10. The validity window for a document extracted with
 * plan_year=Y is:
 *
 *   valid_window_start = Jan 1 of Y - 6 months (accommodates open-enrollment uploads)
 *   valid_window_end   = Dec 31 of Y + 18 months (accommodates late uploads + dispute lead time)
 *
 * Routing:
 *   IF doc.created_at ∈ valid_window AND extracted plan_year exists
 *     → Route to canonical matching plan_year (current OR historical canonical)
 *     → Apply standard algorithm (Layers 1-5)
 *
 *   ELSE
 *     → Store on user's insurance_plans row with `historical_only=TRUE`
 *     → No contribution to ANY canonical's stability or coverage
 *     → Available for user's own dispute references with disclaimer
 *
 * MVP assumption: all plans treated as calendar-year (Jan 1 - Dec 31). Off-cycle
 * employer plans + Medicare quarter splits are Phase 2 follow-ups per Subplan §6
 * ("Plan-year-aware applicability config | Phase 2").
 *
 * Cross-reference: existing year-rollover detection in
 * `src/lib/plan/process-plan.ts:447-465` triggers when an SBC upload introduces
 * a NEW plan_year vs the user's currently-active plan. This module is upstream
 * of that — the validity window determines IF a doc participates in canonical
 * routing AT ALL.
 */

export interface PlanYearValidityWindow {
  /** Start of the validity window (inclusive). */
  windowStart: Date;
  /** End of the validity window (inclusive). */
  windowEnd: Date;
  /** The plan_year that this window covers (echoed for telemetry). */
  planYear: number;
}

/**
 * Compute the plan-year validity window for a given plan_year.
 *
 * MVP: calendar-year assumption. plan_year=2026 → window
 *   [2025-07-01 00:00:00Z, 2028-06-30 23:59:59.999Z]
 * which is plan_year_start - 6mo to plan_year_end + 18mo.
 */
export function computeValidityWindow(planYear: number): PlanYearValidityWindow {
  // 6 months before Jan 1 of planYear == July 1 of planYear - 1.
  // Construct directly to avoid JS month-overflow gotchas (e.g.,
  // setUTCMonth(11 + 18) on Dec 31 rolls into July 1 because June only has 30
  // days). Direct construction yields exact boundaries.
  const windowStart = new Date(Date.UTC(planYear - 1, 6, 1, 0, 0, 0, 0));
  // 18 months after Dec 31 of planYear == June 30 of planYear + 2.
  const windowEnd = new Date(Date.UTC(planYear + 2, 5, 30, 23, 59, 59, 999));

  return { windowStart, windowEnd, planYear };
}

/**
 * Check whether `uploadedAt` falls within the validity window for `planYear`.
 * Returns false if planYear is missing (caller should fall back to absolute
 * 12-month doc age check per Subplan §2.10 "Unextractable plan_year").
 */
export function isWithinValidityWindow(
  uploadedAt: Date | string | null | undefined,
  planYear: number | null | undefined,
): boolean {
  if (planYear == null || uploadedAt == null) return false;
  const ts = uploadedAt instanceof Date ? uploadedAt : new Date(uploadedAt);
  if (Number.isNaN(ts.getTime())) return false;
  const window = computeValidityWindow(planYear);
  return ts >= window.windowStart && ts <= window.windowEnd;
}

/**
 * Routing decision per Subplan §2.10.
 *
 * - `route_to_canonical`: doc is within valid_window for an extracted plan_year;
 *   participates in Pattern 1 #16 algorithm normally.
 * - `historical_only`: doc is outside the validity window; insurance_plans row
 *   gets `historical_only=TRUE`; NO canonical contribution; user retains access
 *   for own dispute references with a disclaimer.
 * - `fallback_absolute_age`: plan_year couldn't be extracted; caller should
 *   fall back to absolute 12-month doc age check (legacy behavior).
 */
export type ValidityRoutingDecision =
  | { decision: "route_to_canonical"; planYear: number; window: PlanYearValidityWindow }
  | {
      decision: "historical_only";
      planYear: number;
      window: PlanYearValidityWindow;
      reason: "past_window" | "before_window";
    }
  | { decision: "fallback_absolute_age"; reason: "missing_plan_year" | "missing_uploaded_at" };

export function decideValidityRouting(
  uploadedAt: Date | string | null | undefined,
  planYear: number | null | undefined,
): ValidityRoutingDecision {
  if (planYear == null) {
    return { decision: "fallback_absolute_age", reason: "missing_plan_year" };
  }
  if (uploadedAt == null) {
    return { decision: "fallback_absolute_age", reason: "missing_uploaded_at" };
  }
  const ts = uploadedAt instanceof Date ? uploadedAt : new Date(uploadedAt);
  if (Number.isNaN(ts.getTime())) {
    return { decision: "fallback_absolute_age", reason: "missing_uploaded_at" };
  }

  const window = computeValidityWindow(planYear);
  if (ts >= window.windowStart && ts <= window.windowEnd) {
    return { decision: "route_to_canonical", planYear, window };
  }
  return {
    decision: "historical_only",
    planYear,
    window,
    reason: ts < window.windowStart ? "before_window" : "past_window",
  };
}

/**
 * Legacy fallback when plan_year is unextractable: absolute 12-month doc-age
 * window from `now`. Returns true if uploadedAt is within the last 12 months.
 */
export function isWithinAbsoluteAge(
  uploadedAt: Date | string | null | undefined,
  now: Date = new Date(),
  maxAgeMonths: number = 12,
): boolean {
  if (uploadedAt == null) return false;
  const ts = uploadedAt instanceof Date ? uploadedAt : new Date(uploadedAt);
  if (Number.isNaN(ts.getTime())) return false;
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - maxAgeMonths);
  return ts >= cutoff;
}
