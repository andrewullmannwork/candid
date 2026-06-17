-- =============================================================================
-- MIGRATION 166 — erasure write guard (S204, OPS.9 follow-on)
-- =============================================================================
--
-- Closes the in-flight-parse gap in the S199/S202 erasure design: an async parse
-- already enqueued (QStash EOC-resume, or a long sync parse) could re-INSERT a
-- user's CHD AFTER they erased it (consent revoke / account delete), because the
-- persist writes are spread across 6+ call sites in 6 files and none re-checked
-- erasure at write time. Guarding each call site app-side is incomplete (a future
-- writer bypasses it) and racy (check-then-write TOCTOU).
--
-- Instead this enforces at the DB on the THREE user-CHD insert-target tables, so
-- the guard is provably complete (every writer — app, script, admin, future — and
-- airtight (the check + the insert are one transaction; no TOCTOU). Children
-- (plan_covered_services, claim_line_items) need no trigger: blocking the parent
-- insert prevents the child (no parent row), and re-parse UPDATEs no-op on rows
-- already deleted by erasure.
--
-- SIGNAL: users.chd_erased_at (additive, nullable). Set in the revoke route
-- (atomic with the erasure); cleared on re-grant of health_data_upload consent.
-- account-delete is covered for free (deleting the users row makes any later
-- insurance_plans/claims insert fail the user_id FK).
--
-- KILL-SWITCH: feature_flag_rules 'erasure_write_guard' (seeded OFF below). When
-- OFF (or absent) the trigger is a byte-identical pass-through, so this migration
-- is INERT on apply. Flip ON only after a real revoke-during-parse test on the
-- dev clone (per OPS.9). Flip OFF = instant disable, no migration revert.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_erasure_write_guard ON insurance_plans;
--   DROP TRIGGER IF EXISTS trg_erasure_write_guard ON claims;
--   DROP TRIGGER IF EXISTS trg_erasure_write_guard ON canonical_haiku_extractions;
--   DROP FUNCTION IF EXISTS enforce_erasure_write_guard();
--   DELETE FROM feature_flag_rules WHERE flag_key = 'erasure_write_guard';
--   ALTER TABLE users DROP COLUMN IF EXISTS chd_erased_at;  -- only after code refs removed
-- =============================================================================

-- 1. Erasure marker. Nullable + additive (Rule #7). Set on revoke, cleared on re-grant.
ALTER TABLE users ADD COLUMN IF NOT EXISTS chd_erased_at timestamptz;
COMMENT ON COLUMN users.chd_erased_at IS
  'Set when the user erases their CHD (consent revoke / pre account-delete), cleared on re-grant of health_data_upload. Gates parse-persist via enforce_erasure_write_guard (mig 166, S204 OPS.9). Also re-blocks the post-revoke upload gate.';

-- 2. Guard function. SECURITY DEFINER so it can always read the flag + users row
--    regardless of the inserting role (search_path pinned to prevent shadowing).
--    Pass-through unless the kill-switch flag is explicitly ON.
CREATE OR REPLACE FUNCTION enforce_erasure_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  guard_on boolean;
  erased timestamptz;
BEGIN
  -- Kill-switch: OFF or absent -> byte-identical pass-through.
  SELECT enabled INTO guard_on
    FROM feature_flag_rules
    WHERE flag_key = 'erasure_write_guard'
    LIMIT 1;
  IF guard_on IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- A NULL user_id (admin / cold-start seed rows) is not a user's CHD -> allow.
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT chd_erased_at INTO erased
    FROM users
    WHERE id = NEW.user_id;

  IF erased IS NOT NULL THEN
    RAISE EXCEPTION 'erasure_write_guard blocked insert into % for user % with erased CHD', TG_TABLE_NAME, NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_erasure_write_guard() IS
  'BEFORE INSERT guard (mig 166): blocks re-creating a CHD row for a user whose chd_erased_at is set, once feature flag erasure_write_guard is ON. Pass-through when the flag is OFF.';

-- 3. Triggers on the three user-CHD insert-target tables.
DROP TRIGGER IF EXISTS trg_erasure_write_guard ON insurance_plans;
CREATE TRIGGER trg_erasure_write_guard
  BEFORE INSERT ON insurance_plans
  FOR EACH ROW EXECUTE FUNCTION enforce_erasure_write_guard();

DROP TRIGGER IF EXISTS trg_erasure_write_guard ON claims;
CREATE TRIGGER trg_erasure_write_guard
  BEFORE INSERT ON claims
  FOR EACH ROW EXECUTE FUNCTION enforce_erasure_write_guard();

DROP TRIGGER IF EXISTS trg_erasure_write_guard ON canonical_haiku_extractions;
CREATE TRIGGER trg_erasure_write_guard
  BEFORE INSERT ON canonical_haiku_extractions
  FOR EACH ROW EXECUTE FUNCTION enforce_erasure_write_guard();

-- 4. Kill-switch flag, seeded OFF (mirror mig 160 shape: flag_key, enabled,
--    description, target_type, config; flag_key is the sole UNIQUE).
INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'erasure_write_guard',
  false,
  'S204 (OPS.9). When ON, a BEFORE INSERT trigger on insurance_plans / claims / canonical_haiku_extractions blocks a row whose user_id has users.chd_erased_at set (CHD erased via revoke or account-delete) -- closes the in-flight-parse resurrection gap. OFF = byte-identical pass-through. Flip ON only after a real revoke-during-parse test on the dev clone. Rollback = flip OFF.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
