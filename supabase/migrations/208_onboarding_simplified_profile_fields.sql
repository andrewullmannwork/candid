-- =============================================================================
-- MIGRATION 208 — simplified onboarding: household + situation chips on profiles
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
--
--   The Simplified Onboarding design (2026-07-17 handoff; plan:
--   onboarding_doc_first_reorder.md v10, S285) asks two questions the schema
--   cannot store today:
--
--   1. "Who's on this plan?" — a coarse household-composition pick, one of
--      four tiles. NOT the same thing as profiles.dependents (a NAMED ROSTER
--      with per-person DOB/sex, edited post-onboarding) and NOT the same as
--      insurance_plans.coverage_tier (the plan's enrollment tier). The
--      benefits personalizer reads the roster first and falls back to this
--      enum (e.g. hasChildren = roster child OR household includes kids).
--
--   2. "What brings you here?" — multi-select situation chips.
--      profiles.primary_concern STAYS: it is the free-text one-liner that
--      accompanies the chips (the design shows it once any chip is selected).
--
-- Additive only (Rule 7). No backfill: both fields are new information no
-- existing flow ever collected; NULL = never asked (distinct from asked-and-
-- declined, which the UI records as an empty selection left NULL — declining
-- is not data we store).
--
-- APPLY ORDER: DEV wdpk… first (localhost build/testing), PROD viahl… at the
--   ship promote, before any flag flip. Bare-statement paste per the mig-189
--   Studio lesson (strip BEGIN/COMMIT + comments), then verify with:
--     SELECT column_name FROM information_schema.columns
--     WHERE table_name='profiles' AND column_name IN ('household','situation_tags');
--
-- BACKOUT — columns are additive + nullable; all readers null-tolerate.
--   Leave in place, or DROP COLUMN when convenient after code no longer
--   references them.

BEGIN;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS household text
  CONSTRAINT profiles_household_check
  CHECK (household IN ('just_me', 'me_spouse', 'me_kids', 'me_spouse_kids'));

COMMENT ON COLUMN profiles.household IS
  'Simplified onboarding (mig 208): coarse household composition from the "Who''s on this plan?" tiles — just_me | me_spouse | me_kids | me_spouse_kids. Coexists with the finer-grained dependents roster (jsonb); personalization reads roster first, this as fallback. NULL = never answered.';

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS situation_tags text[]
  CONSTRAINT profiles_situation_tags_check
  CHECK (
    situation_tags <@ ARRAY[
      'er_bill',
      'oon_surprise_bill',
      'denied_claim',
      'bill_too_high',
      'hidden_benefits',
      'plan_shopping',
      'staying_ahead'
    ]::text[]
  );

COMMENT ON COLUMN profiles.situation_tags IS
  'Simplified onboarding (mig 208): multi-select "What brings you here?" chips (slugs; display strings live in src/lib/onboarding/simplified.ts). Accompanying free text stays in primary_concern. Used to prioritize audit checks. NULL = never answered; adding a new chip requires widening the CHECK in a future migration.';

COMMIT;
