-- =============================================================================
-- MIGRATION 186 — Dispute pin = explicit-override-only (repair stale auto-pins)
-- =============================================================================
--
-- CONTEXT
-- Migration 171 added dispute_outcomes.insurance_plan_id (the "pin") and intended
-- it to be "set at draft from claims.insurance_plan_id (DOS-correct) or the user
-- confirm/override chooser." In practice two code paths AUTO-wrote it without an
-- explicit user choice:
--   (a) /api/disputes/generate persisted the *resolved* plan as the pin, and
--   (b) the GET /api/disputes/[disputeId] "R5 lazy backfill" persisted whatever
--       the resolver returned (a fragile year-match among duplicate plans).
-- Once written, the pin was never re-synced to the claim. Result: a dispute's
-- pin could FREEZE a plan that diverged from the claim's corrected DOS plan
-- (observed in PROD: a dispute pinned to a "Sequoia One PEO / Open Access Plus"
-- row while its claim's plan was corrected to "Health Net of CA / Ambetter").
--
-- NEW MODEL (shipped alongside this migration, NO LONGER flag-gated):
--   dispute_outcomes.insurance_plan_id holds an EXPLICIT USER OVERRIDE ONLY
--   (written only by the chooser at /generate and by /repin). When NULL, the
--   resolver reads the claim's LIVE DOS-correct plan (claims.insurance_plan_id),
--   so a corrected claim flows through automatically with no staleness. The two
--   auto-write paths above were removed in the same change.
--
-- WHAT THIS MIGRATION DOES
--   One-time repair: NULL every pre-existing pin, because none of them were set
--   by an explicit user action — the feature never launched (flag OFF) and a
--   pre-migration audit found 0 disputes carrying any explicit-override marker
--   (canonicalPlanIdForBillYear / userConfirmedSamePlan). After this, a non-null
--   pin unambiguously means "the user deliberately chose this plan", which is the
--   invariant the resolver now relies on.
--
--   Guarded on sent_at IS NULL: a sent letter is an immutable record (its frozen
--   letter_content is unaffected by the pin), so we do not touch sent rows. The
--   pre-migration audit found 0 sent/filed disputes carrying a pin, so in
--   practice this guard excludes nothing today; it is defensive for safety.
--
-- SAFETY: idempotent (re-running nulls nothing once clean). Resolution after the
--   null is strictly correct — it falls back to the claim's DOS-correct plan.
--   ON DELETE SET NULL FK is unchanged. No schema change; data-only.
-- =============================================================================

DO $$
DECLARE
  repaired INTEGER;
BEGIN
  UPDATE dispute_outcomes
     SET insurance_plan_id = NULL
   WHERE insurance_plan_id IS NOT NULL
     AND sent_at IS NULL;

  GET DIAGNOSTICS repaired = ROW_COUNT;
  RAISE NOTICE 'migration 186: nulled % stale auto-seeded dispute pin(s); resolution now defaults to the claim''s live DOS-correct plan', repaired;
END $$;
