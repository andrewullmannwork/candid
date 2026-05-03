-- Migration 066: canonical_plans.verification_count + maintenance trigger
--
-- Phase 4 Task 4-B (Session 56). Closes Q-DR-4B-1 (reliability over compute-on-the-fly):
-- denormalized count of distinct users who have an insurance_plans row linked to a
-- given canonical_plan_id. Maintained transactionally via trigger so the API can read
-- a single column for sourceCount in the consumer-read filter without aggregate queries
-- under load.
--
-- WHY this exists: at Pattern 1 #4 threshold = 3 (configurable via feature flag
-- pattern1_corroboration_threshold), every consumer surface flips its display state
-- when a third user uploads matching plan data. The count value is the single most
-- important number governing flywheel display correctness. Compute-on-the-fly via
-- COUNT(DISTINCT user_id) was rejected per user direction Session 56: reliability
-- bar requires the value to be a denormalized integer the database maintains
-- atomically, not an aggregate the API recomputes per request.
--
-- WHY canonical_plans (not canonical_plan_services or insurance_plans):
--   - canonical_plans is the plan-level table; corroboration is at PLAN level
--     (N distinct users uploaded SBC/EOC/plan-doc that resolved to this canonical).
--   - canonical_plan_services rows inherit plan-level corroboration; field-level
--     value-disagreement detection is a Phase 5 concern (per Pattern 1 #4 audit
--     item #10 in session_55_data_integrity_triage). Phase 4 closes the binary
--     "is this plan corroborated" gate; Phase 5 adds per-field-value granularity.
--   - insurance_plans.verification_count exists from mig 009 with different semantics
--     (per-row plan match confidence, set by canonical-match scoring); not the same
--     concept as canonical-plan corroboration.
--
-- Idempotency: the trigger uses NOT EXISTS guards to handle: (a) first user uploads
-- → +1; (b) second user uploads same plan → +1; (c) same user re-uploads (multiple
-- insurance_plans rows for one user across plan years) → no double-count;
-- (d) user deletes account → -1 (but only if they had no other rows for this plan);
-- (e) canonical reassignment via plan-merge → -1 old / +1 new.
--
-- Backfill: from existing insurance_plans rows. Distinct user count per canonical_plan_id.
-- Run AFTER table column add, BEFORE trigger creation, so trigger doesn't double-count
-- the backfill data.

BEGIN;

-- ── 1. Column add (additive, NOT NULL with default — safe under concurrent writes) ──

ALTER TABLE canonical_plans
  ADD COLUMN IF NOT EXISTS verification_count INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN canonical_plans.verification_count IS
  'Denormalized count of distinct user_ids with an insurance_plans row linked to this canonical_plan_id. Maintained by trigger maintain_canonical_verification_count on insurance_plans. Used by /api/plan/analyze (Phase 4 Task 4-B) for Pattern 1 #4 sourceCount.';

-- ── 2. Backfill from existing data (one-time) ──

UPDATE canonical_plans cp
SET verification_count = COALESCE(sub.cnt, 0)
FROM (
  SELECT canonical_plan_id, COUNT(DISTINCT user_id) AS cnt
  FROM insurance_plans
  WHERE canonical_plan_id IS NOT NULL
  GROUP BY canonical_plan_id
) sub
WHERE cp.id = sub.canonical_plan_id;

-- ── 3. Maintenance trigger function ──

CREATE OR REPLACE FUNCTION maintain_canonical_verification_count()
RETURNS TRIGGER AS $$
DECLARE
  user_has_other_row_for_old BOOLEAN;
  user_has_other_row_for_new BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- New row with canonical_plan_id set: increment ONLY if user not already counted
    IF NEW.canonical_plan_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM insurance_plans
        WHERE canonical_plan_id = NEW.canonical_plan_id
          AND user_id = NEW.user_id
          AND id <> NEW.id
      ) INTO user_has_other_row_for_new;

      IF NOT user_has_other_row_for_new THEN
        UPDATE canonical_plans
        SET verification_count = verification_count + 1
        WHERE id = NEW.canonical_plan_id;
      END IF;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    -- canonical_plan_id changed: -1 from old (if last row for that user) / +1 to new (if first)
    IF NEW.canonical_plan_id IS DISTINCT FROM OLD.canonical_plan_id THEN
      -- Decrement old (if user had only this one row for old canonical)
      IF OLD.canonical_plan_id IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1 FROM insurance_plans
          WHERE canonical_plan_id = OLD.canonical_plan_id
            AND user_id = OLD.user_id
            AND id <> OLD.id
        ) INTO user_has_other_row_for_old;

        IF NOT user_has_other_row_for_old THEN
          UPDATE canonical_plans
          SET verification_count = GREATEST(0, verification_count - 1)
          WHERE id = OLD.canonical_plan_id;
        END IF;
      END IF;

      -- Increment new (if user not already counted on new canonical)
      IF NEW.canonical_plan_id IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1 FROM insurance_plans
          WHERE canonical_plan_id = NEW.canonical_plan_id
            AND user_id = NEW.user_id
            AND id <> NEW.id
        ) INTO user_has_other_row_for_new;

        IF NOT user_has_other_row_for_new THEN
          UPDATE canonical_plans
          SET verification_count = verification_count + 1
          WHERE id = NEW.canonical_plan_id;
        END IF;
      END IF;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    -- Row deleted: decrement if user had only this row for that canonical
    IF OLD.canonical_plan_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM insurance_plans
        WHERE canonical_plan_id = OLD.canonical_plan_id
          AND user_id = OLD.user_id
          AND id <> OLD.id
      ) INTO user_has_other_row_for_old;

      IF NOT user_has_other_row_for_old THEN
        UPDATE canonical_plans
        SET verification_count = GREATEST(0, verification_count - 1)
        WHERE id = OLD.canonical_plan_id;
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION maintain_canonical_verification_count() IS
  'Phase 4 Task 4-B (Session 56). Maintains canonical_plans.verification_count atomically as insurance_plans rows are added/changed/deleted. Idempotent across same-user multi-row uploads (e.g., plan year rollover creates new insurance_plans row for same user/canonical — does NOT double-count).';

-- ── 4. Attach trigger ──

DROP TRIGGER IF EXISTS trigger_maintain_canonical_verification_count ON insurance_plans;

CREATE TRIGGER trigger_maintain_canonical_verification_count
  AFTER INSERT OR UPDATE OF canonical_plan_id OR DELETE
  ON insurance_plans
  FOR EACH ROW
  EXECUTE FUNCTION maintain_canonical_verification_count();

COMMIT;
