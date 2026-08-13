/**
 * The allowlist of feature flags readable from the browser.
 *
 * WHY IT LIVES HERE rather than inside the route: two consumers need it. The
 * endpoint (`/api/feature-flags/[flagKey]`) enforces it at RUNTIME, and
 * `useFeatureFlag` derives its parameter TYPE from it, so a client read of an
 * un-allowlisted flag is a COMPILE error instead of a silent OFF. One
 * derivation, two consumers — the list and the type cannot disagree.
 *
 * The silent OFF is not hypothetical. S302: `bill_totals_source_v1` was ON in
 * the database, the feature was built and tested, and it rendered nowhere
 * because the allowlist entry was missing — the endpoint 404s an unknown key
 * and every client treats a missing `enabled` as false. It cost a full E2E
 * round to find.
 *
 * Adding a client-read flag = add the key here. Nothing else to keep in sync.
 */

/**
 * `feature_flag_rules` boolean-engine flags (resolved via `isFeatureEnabled`).
 * Whitelisted so we don't accidentally leak operational flags to the browser:
 * server-only gates (e.g. `case_timeline_v1`, `dispute_draft_live_rebuild_v1`)
 * deliberately stay OFF this list and are read server-side only.
 */
export const EXPOSED_FLAGS = [
  "embedded_subscribe",
  "dispute_tracking",
  "dispute_feedback_loop",
  "plan_year_rollover",
  "benefit_corrections",
  "compare_v2_redesign", // S157 Compare v2 results reskin (frontend UI gate)
  "change_plan_v1", // S207 Stretch 1 — Change plan control on /plan
  "case_file_enriched_v1", // S207 Stretch 2 — enriched Case File download on /disputes
  "dispute_plan_pinning_v1", // S210 Mid-year plan change × disputes — plan pinning (P0)
  "dispute_letters_free_start_v1", // 2026-07 dispute-letters free-to-start FE alignment gate
  "onboarding_simplified_v1", // Simplified onboarding (S285) — /onboarding route, profile meter, signup redirect
  "guided_steps_v1", // S297 Guided Steps v1 — phone subflow on /claim, spine packs C/D, done-step rail collapse
  "case_rail_v1", // S299 Timeline unification phase 1a — extended claim rail UI (spine gated separately by case_timeline_v1)
  "letter_requirements_v1", // S301 — each letter asks only for what it needs (CaseNeedsPanel row set; gaps + readiness floor gate server-side on the same flag)
  "bill_totals_source_v1", // S302 — "which of our two parses is right" row in the step-1 assumptions block
  "savings_math_derivation_v1", // S307 — priced-answer plan card + "Where these numbers come from" strip
] as const;

/**
 * KV-store flags exposed through the same endpoint. Two-system note: the keys
 * above live in the `feature_flag_rules` boolean engine (`isFeatureEnabled`);
 * these live in the `feature_flags` KV store behind /admin/settings
 * (`getFlags`). Only the toggle STATE is exposed — never the allowlisted
 * number itself.
 */
export const EXPOSED_KV_FLAGS = [
  "TEST_PHONE_EXEMPTION_ENABLED", // S288 test-phone exemption kill switch (signup pre-check)
] as const;

/**
 * Every key the browser may ask for — `useFeatureFlag`'s parameter type.
 * Widening this type is deliberate: it only happens by adding a key above.
 */
export type ExposedFlag =
  | (typeof EXPOSED_FLAGS)[number]
  | (typeof EXPOSED_KV_FLAGS)[number];

/** Runtime membership tests for the route. */
export const EXPOSED_FLAG_SET: ReadonlySet<string> = new Set(EXPOSED_FLAGS);
export const EXPOSED_KV_FLAG_SET: ReadonlySet<string> = new Set(EXPOSED_KV_FLAGS);
