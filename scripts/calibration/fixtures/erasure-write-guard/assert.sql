-- Erasure write guard fixture (mig 166) — seed + assertions.
-- PRECONDITION: schema-stub.sql + migration 166 applied to the target DB (run.sh does this).
-- NON-MUTATING: everything runs inside a transaction that ROLLBACKs at the end.
--
-- Proves: (S1) flag OFF = byte-identical pass-through (the seeded default — inert on apply);
--   (S2) flag ON, live user → allowed; (S3) flag ON, erased user → BLOCKED on all three
--   guarded tables; (S4) flag ON, NULL user_id (admin/cold-start rows) → allowed;
--   (S5) re-grant (chd_erased_at cleared) → re-allowed.
BEGIN;

INSERT INTO users (id) VALUES
  ('d0000001-0000-0000-0000-000000000001'),   -- U_erased
  ('d0000002-0000-0000-0000-000000000002');   -- U_live
UPDATE users SET chd_erased_at = now() WHERE id = 'd0000001-0000-0000-0000-000000000001';

DO $$
DECLARE
  u_erased CONSTANT UUID := 'd0000001-0000-0000-0000-000000000001';
  u_live   CONSTANT UUID := 'd0000002-0000-0000-0000-000000000002';
  blocked  boolean;
BEGIN
  -- S1 — flag OFF (mig seeded false): erased-user insert ALLOWED (pass-through = inert on apply).
  INSERT INTO insurance_plans (id, user_id) VALUES ('19000001-0000-0000-0000-000000000001', u_erased);
  ASSERT EXISTS(SELECT 1 FROM insurance_plans WHERE id = '19000001-0000-0000-0000-000000000001'),
    'S1 flag-OFF should be a pass-through';
  RAISE NOTICE 'S1 PASS — flag OFF = byte-identical pass-through (erased-user insert allowed)';

  -- Flip the kill-switch ON for the remaining scenarios.
  UPDATE feature_flag_rules SET enabled = true WHERE flag_key = 'erasure_write_guard';

  -- S2 — flag ON, live user → ALLOWED.
  INSERT INTO insurance_plans (id, user_id) VALUES ('19000002-0000-0000-0000-000000000002', u_live);
  ASSERT EXISTS(SELECT 1 FROM insurance_plans WHERE id = '19000002-0000-0000-0000-000000000002'),
    'S2 live user should be allowed';
  RAISE NOTICE 'S2 PASS — flag ON, live user allowed';

  -- S3 — flag ON, erased user → BLOCKED on all three guarded tables.
  blocked := false;
  BEGIN
    INSERT INTO insurance_plans (id, user_id) VALUES ('19000003-0000-0000-0000-000000000003', u_erased);
  EXCEPTION WHEN check_violation THEN blocked := true;
  END;
  ASSERT blocked, 'S3a insurance_plans should be blocked for erased user';
  ASSERT NOT EXISTS(SELECT 1 FROM insurance_plans WHERE id = '19000003-0000-0000-0000-000000000003'),
    'S3a no insurance_plans row should have landed';

  blocked := false;
  BEGIN
    INSERT INTO claims (id, user_id) VALUES ('c1000003-0000-0000-0000-000000000003', u_erased);
  EXCEPTION WHEN check_violation THEN blocked := true;
  END;
  ASSERT blocked, 'S3b claims should be blocked for erased user';

  blocked := false;
  BEGIN
    INSERT INTO canonical_haiku_extractions (id, user_id) VALUES ('11000003-0000-0000-0000-000000000003', u_erased);
  EXCEPTION WHEN check_violation THEN blocked := true;
  END;
  ASSERT blocked, 'S3c canonical_haiku_extractions should be blocked for erased user';
  RAISE NOTICE 'S3 PASS — flag ON, erased user blocked on insurance_plans + claims + canonical_haiku_extractions';

  -- S4 — flag ON, NULL user_id (admin / cold-start seed rows) → ALLOWED.
  INSERT INTO canonical_haiku_extractions (id, user_id) VALUES ('11000004-0000-0000-0000-000000000004', NULL);
  ASSERT EXISTS(SELECT 1 FROM canonical_haiku_extractions WHERE id = '11000004-0000-0000-0000-000000000004'),
    'S4 NULL user_id should be allowed';
  RAISE NOTICE 'S4 PASS — flag ON, NULL user_id allowed (admin/cold-start rows)';

  -- S5 — re-grant clears the marker → insert ALLOWED again.
  UPDATE users SET chd_erased_at = NULL WHERE id = u_erased;
  INSERT INTO insurance_plans (id, user_id) VALUES ('19000005-0000-0000-0000-000000000005', u_erased);
  ASSERT EXISTS(SELECT 1 FROM insurance_plans WHERE id = '19000005-0000-0000-0000-000000000005'),
    'S5 cleared marker should re-allow insert';
  RAISE NOTICE 'S5 PASS — re-grant (chd_erased_at cleared) re-allows insert';

  RAISE NOTICE '==== ALL ERASURE-WRITE-GUARD ASSERTIONS PASSED ====';
END $$;

ROLLBACK;
