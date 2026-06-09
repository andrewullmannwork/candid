-- Phase 1a mig-157 fixture — assertions for the plan_covered_services 3→4-col re-key + the
-- benefit_corrections cell columns. PRECONDITION: schema-stub-157.sql + migration 157 applied
-- (run-157.sh does this). NON-MUTATING: everything runs inside a transaction that ROLLBACKs.
--
-- Proves: (A) the mig-009 inline 3-col UNIQUE is GONE (discovered name-agnostically + dropped);
--   (B) the named 4-col uq_plan_covered_service EXISTS; (C) two component-variants of one
--   (plan,service,pos) COEXIST under the 4-col key; (D) a true 4-col duplicate is REJECTED;
--   (E) benefit_corrections gained place_of_service + component.
BEGIN;

DO $$
DECLARE
  n INT;
BEGIN
  -- A — the 3-col UNIQUE (whatever its auto-name) is gone.
  SELECT count(*) INTO n
  FROM pg_constraint con
  WHERE con.conrelid = 'plan_covered_services'::regclass
    AND con.contype = 'u'
    AND (
      SELECT array_agg(att.attname::text ORDER BY att.attname)   -- ::text: attname is `name`; literal is text[]
      FROM unnest(con.conkey) AS k(attnum)
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
    ) = ARRAY['insurance_plan_id','place_of_service','service_id'];
  ASSERT n = 0, 'A FAIL — 3-col UNIQUE still present after mig 157';

  -- B — the named 4-col key exists.
  SELECT count(*) INTO n
  FROM pg_constraint
  WHERE conname = 'uq_plan_covered_service'
    AND conrelid = 'plan_covered_services'::regclass
    AND contype = 'u';
  ASSERT n = 1, 'B FAIL — uq_plan_covered_service (4-col) missing';

  -- E — benefit_corrections cell-capture columns added.
  SELECT count(*) INTO n
  FROM information_schema.columns
  WHERE table_name = 'benefit_corrections' AND column_name IN ('place_of_service','component');
  ASSERT n = 2, 'E FAIL — benefit_corrections place_of_service/component missing';

  RAISE NOTICE 'A/B/E PASS — 3-col unique gone; 4-col uq_plan_covered_service present; benefit_corrections cells added';
END $$;

-- C — two component-variants of ONE (plan, service, place_of_service) coexist.
INSERT INTO plan_covered_services (insurance_plan_id, service_id, place_of_service, component) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','outpatient_facility','facility'),
  ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','outpatient_facility','professional');

-- D — a TRUE 4-col duplicate (same component) is rejected.
DO $$
BEGIN
  INSERT INTO plan_covered_services (insurance_plan_id, service_id, place_of_service, component)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','outpatient_facility','facility');
  RAISE EXCEPTION 'D FAIL — 4-col duplicate was NOT rejected';
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE 'C/D PASS — two component-variants coexist; true 4-col duplicate rejected';
END $$;

-- F — apply_promotion_event (PART C): the annual_limit arm syncs the typed column + provenance;
--     an existing field (copay) + the canonical_plans (plan-identity) branch still work → the
--     full-body reproduction is faithful (no transcription regression).
INSERT INTO canonical_plans (id, field_provenance) VALUES ('cccccccc-0000-0000-0000-000000000001', '{}'::jsonb);

DO $$
DECLARE
  cp       CONSTANT UUID := 'cccccccc-0000-0000-0000-000000000001';
  v_annual INT;
  v_copay  NUMERIC;
  v_src    TEXT;
  v_prov   JSONB;
  v_pname  TEXT;
BEGIN
  -- annual_limit (the NEW arm) via admin_override → INSERT a fresh cell with typed col + provenance.
  PERFORM apply_promotion_event(cp, 'surgery', 'annual_limit', '20'::jsonb, '[]'::jsonb, 'admin-ui', NULL, 'admin_override', 'outpatient_facility', 'facility');
  SELECT annual_limit, source, field_provenance INTO v_annual, v_src, v_prov
  FROM canonical_plan_services
  WHERE canonical_plan_id = cp AND service_slug = 'surgery' AND place_of_service = 'outpatient_facility' AND component = 'facility';
  ASSERT v_annual = 20, 'F FAIL — annual_limit typed col = ' || COALESCE(v_annual::text, 'NULL');
  ASSERT (v_prov->'annual_limit'->>'value') = '20', 'F FAIL — annual_limit provenance value';
  ASSERT v_src = 'admin_attested', 'F FAIL — source = ' || COALESCE(v_src, 'NULL');

  -- copay (an EXISTING arm) on the same cell → ON CONFLICT UPDATE; annual_limit must survive.
  PERFORM apply_promotion_event(cp, 'surgery', 'copay', '50'::jsonb, '[]'::jsonb, 'admin-ui', NULL, 'admin_override', 'outpatient_facility', 'facility');
  SELECT copay, annual_limit INTO v_copay, v_annual
  FROM canonical_plan_services
  WHERE canonical_plan_id = cp AND service_slug = 'surgery' AND place_of_service = 'outpatient_facility' AND component = 'facility';
  ASSERT v_copay = 50, 'F FAIL — copay typed col = ' || COALESCE(v_copay::text, 'NULL');
  ASSERT v_annual = 20, 'F FAIL — annual_limit clobbered by a later copay write = ' || COALESCE(v_annual::text, 'NULL');

  -- canonical_plans (plan-identity) branch still works → full-body reproduction faithful.
  PERFORM apply_promotion_event(cp, NULL, 'plan_name', '"Test Plan"'::jsonb, '[]'::jsonb, 'admin-ui', NULL, 'admin_override');
  SELECT plan_name INTO v_pname FROM canonical_plans WHERE id = cp;
  ASSERT v_pname = 'Test Plan', 'F FAIL — plan_name branch = ' || COALESCE(v_pname, 'NULL');

  RAISE NOTICE 'F PASS — apply_promotion_event: annual_limit arm syncs typed+provenance; copay + plan-identity branches intact';
END $$;

ROLLBACK;
