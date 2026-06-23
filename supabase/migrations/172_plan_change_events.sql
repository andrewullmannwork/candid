-- =============================================================================
-- MIGRATION 172 — Plan-change logbook + activation trigger
-- =============================================================================
--
-- Records the per-user plan-switch TIMELINE so dispute letters can reason about
-- "which plan was active when" across mid-year changes — and so we have a
-- first-class, durable history of which plans each user held and when (valuable
-- product data; the benefits themselves live on the retained insurance_plans
-- rows, this table supplies the WHEN).
--
-- WHY A TRIGGER (not app code): a plan becomes active in at least four distinct
-- code paths — Change-plan search (set-active), Change-plan upload + new-year
-- auto-activate (documents/status, process-plan), and card-scan/manual entry
-- (profile). Stamping the switch in each path would drift the moment a fifth
-- path is added. A single AFTER-trigger on insurance_plans captures EVERY
-- activation — present and future — and naturally ignores the
-- inserted-as-inactive (pending-confirmation) rows, because it fires only on a
-- genuine transition INTO active.
--
-- WHAT IT ADDS:
--   1. plan_change_events — append-only log: (user_id, insurance_plan_id that
--      became active, previous_plan_id deactivated, changed_at). Immutable;
--      revert/interval interpretation is derived at read time. Provenance (which
--      screen) is derivable by joining insurance_plans.source — no app-path
--      dependency needed.
--   2. record_plan_activation() + the insurance_plans trigger that writes one
--      row per activation transition (skipping no-op re-selection of the same
--      plan).
--
-- NOTES:
--   - insurance_plans.activated_at (mig 171) stays DORMANT — this log is the
--     source of truth for activation history; the column can be lit later as a
--     denormalized cache if profiling ever needs it.
--   - User-scoped data (Pattern 1 #14); cross-user analytics must go through the
--     >=5-user aggregation/anonymization layer (Rule 5). It's an EVENT table, not
--     a duplicate entity table (Rule 1) — same shape as canonical_drift_events.
--   - FK plan refs ON DELETE SET NULL so CHD erasure (OPS.9) can't be blocked by
--     this table; the de-identified event (a switch happened at T) survives.
--
-- ROLLBACK: DROP TRIGGER insurance_plans_record_activation ON insurance_plans;
--   DROP FUNCTION record_plan_activation(); (table is additive, leave in place).
-- =============================================================================

-- 1. The logbook ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_change_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  insurance_plan_id UUID REFERENCES insurance_plans(id) ON DELETE SET NULL,
  previous_plan_id UUID REFERENCES insurance_plans(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE plan_change_events IS
  'Append-only per-user plan-switch timeline. One row each time a plan becomes the user''s active plan (written by the record_plan_activation trigger on insurance_plans). insurance_plan_id = plan activated; previous_plan_id = plan it replaced (null on first activation). Source of truth for "which plan was active when" (dispute plan-change banner + plan/benefit history). Revert/interval interpretation derived at read time. Provenance via join to insurance_plans.source. User-scoped (Pattern 1 #14); global analytics via the >=5-user aggregation layer (Rule 5).';

CREATE INDEX IF NOT EXISTS idx_plan_change_events_user_changed
  ON plan_change_events(user_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_plan_change_events_plan
  ON plan_change_events(insurance_plan_id);

-- 2. The activation trigger -------------------------------------------------
CREATE OR REPLACE FUNCTION record_plan_activation()
RETURNS TRIGGER AS $$
DECLARE
  prev_plan UUID;
BEGIN
  -- Fire only on a genuine transition INTO active (insert-as-active, or
  -- false/null -> true). Pending-confirmation rows inserted as is_active=false
  -- are ignored until they actually become active.
  IF NEW.is_active IS TRUE AND (TG_OP = 'INSERT' OR OLD.is_active IS DISTINCT FROM TRUE) THEN
    -- Previous active plan = the most recent prior activation for this user.
    -- Read from the log (not live is_active) because callers deactivate the old
    -- row in a separate statement within the same transaction.
    SELECT insurance_plan_id INTO prev_plan
      FROM plan_change_events
      WHERE user_id = NEW.user_id
      ORDER BY changed_at DESC
      LIMIT 1;

    -- Skip no-op re-selection of the already-current plan (keeps the log clean).
    IF prev_plan IS DISTINCT FROM NEW.id THEN
      INSERT INTO plan_change_events (user_id, insurance_plan_id, previous_plan_id, changed_at)
        VALUES (NEW.user_id, NEW.id, prev_plan, now());
    END IF;
  END IF;
  RETURN NULL; -- AFTER trigger: return value ignored
END;
$$ LANGUAGE plpgsql;

-- DROP+CREATE (not CREATE OR REPLACE TRIGGER — PG14+ silently no-ops that form
-- on Studio apply; see mig 169 retro).
DROP TRIGGER IF EXISTS insurance_plans_record_activation ON insurance_plans;
CREATE TRIGGER insurance_plans_record_activation
  AFTER INSERT OR UPDATE OF is_active ON insurance_plans
  FOR EACH ROW
  EXECUTE FUNCTION record_plan_activation();
