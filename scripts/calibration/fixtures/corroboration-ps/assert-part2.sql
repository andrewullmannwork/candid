-- S213 Corroboration-PS Part 2 gate (e) — Case-3 canonical-identity tagging makes a null-canonical
-- (no-match / inactive) EOC plan corroboration-eligible, WITHOUT writing any canonical_plan_services.
-- PRECONDITION: schema-stub.sql + migration 156 applied (run-part2.sh does this). NON-MUTATING: ROLLBACK.
--
-- Part 2 routes a null-canonical EOC plan through findOrCreateCanonicalPlan (identity-only create →
-- never mergeServicesIntoCanonical). This fixture proves the EFFECT at the DB level the TS produces:
--   (PRE)  the Pattern-1 evaluator GROUPs by canonical_plan_id, so a null-canonical plan contributes
--          to NO canonical's count — it is invisible to the flywheel (the systematic EOC gap).
--   (TAG)  set canonical_plan_id = CX (exactly what findOrCreateCanonicalPlan + the .update() do).
--   (POST) the plan joins CX's pool → distinct_user_count crosses threshold → should_promote.
--   (#10)  the identity tag alone created ZERO canonical_plan_services rows.
-- Field = prior_auth_required (the field EOC documents actually contribute — see coverage-targeting.ts).
BEGIN;

INSERT INTO service_catalog (id, slug, concept_id, canonical_for_concept) VALUES
  ('a0000001-0000-0000-0000-000000000001', 'surgery', 'cc000001-0000-0000-0000-000000000001', TRUE);

INSERT INTO canonical_plans (id, field_provenance) VALUES
  ('c9000001-0000-0000-0000-000000000001', '{}'::jsonb);

INSERT INTO users (id, email_verified, phone_verified) VALUES
  ('d0000001-0000-0000-0000-000000000001', TRUE, TRUE),
  ('d0000002-0000-0000-0000-000000000002', TRUE, TRUE),
  ('d0000003-0000-0000-0000-000000000003', TRUE, TRUE);

-- U1 + U2 already tagged to CX (e.g. their SBC uploads); U3 is the Case-3 EOC plan, INITIALLY
-- null-canonical (the gap Part 2 closes).
INSERT INTO insurance_plans (id, user_id, canonical_plan_id) VALUES
  ('19000001-0000-0000-0000-000000000001', 'd0000001-0000-0000-0000-000000000001', 'c9000001-0000-0000-0000-000000000001'),
  ('19000002-0000-0000-0000-000000000002', 'd0000002-0000-0000-0000-000000000002', 'c9000001-0000-0000-0000-000000000001'),
  ('19000003-0000-0000-0000-000000000003', 'd0000003-0000-0000-0000-000000000003', NULL);

-- All 3 verified users agree on prior_auth_required = true (verified excerpt), value-keyed exactly as
-- the EOC + SBC write-paths now produce (buildProvenanceEntry / EocCoverageAccumulator).
INSERT INTO plan_covered_services (insurance_plan_id, service_id, place_of_service, component, field_provenance) VALUES
  ('19000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000001', 'any', 'global',
   '{"prior_auth_required":{"value":true,"source_excerpt":"Prior authorization required","source_excerpt_verified":"verified"}}'::jsonb),
  ('19000002-0000-0000-0000-000000000002', 'a0000001-0000-0000-0000-000000000001', 'any', 'global',
   '{"prior_auth_required":{"value":true,"source_excerpt":"Prior authorization required","source_excerpt_verified":"verified"}}'::jsonb),
  ('19000003-0000-0000-0000-000000000003', 'a0000001-0000-0000-0000-000000000001', 'any', 'global',
   '{"prior_auth_required":{"value":true,"source_excerpt":"Prior authorization required","source_excerpt_verified":"verified"}}'::jsonb);

DO $$
DECLARE
  cp  CONSTANT UUID := 'c9000001-0000-0000-0000-000000000001';
  u3p CONSTANT UUID := '19000003-0000-0000-0000-000000000003';
  r   JSONB;
  n   INT;
BEGIN
  -- PRE-TAG: U3 (null canonical_plan_id) is invisible → CX counts only U1 + U2.
  r := evaluate_pattern1_corroboration(cp, 'surgery', 'prior_auth_required', NULL, NULL);
  ASSERT (r->>'distinct_user_count')::int = 2,
    'PRE distinct_user_count = ' || (r->>'distinct_user_count') || ' (expected 2 — null-canonical U3 must be invisible)';
  RAISE NOTICE 'PRE  PASS — Case-3 null-canonical plan is invisible to corroboration (count 2)';

  -- TAG: exactly what Part 2 does — findOrCreateCanonicalPlan returns CX; .update() sets it.
  UPDATE insurance_plans SET canonical_plan_id = cp WHERE id = u3p;

  -- POST-TAG: U3 joins CX's pool → count 3 → should_promote (canonical confidence is null < 0.9).
  r := evaluate_pattern1_corroboration(cp, 'surgery', 'prior_auth_required', NULL, NULL);
  ASSERT (r->>'distinct_user_count')::int = 3,
    'POST distinct_user_count = ' || (r->>'distinct_user_count') || ' (expected 3)';
  ASSERT (r->>'should_promote')::boolean = TRUE,
    'POST should_promote = ' || (r->>'should_promote') || ' (expected true)';
  RAISE NOTICE 'POST PASS — tagging the Case-3 plan flips it into the flywheel (count 3, should_promote)';

  -- RULE #10: the identity tag alone wrote ZERO canonical_plan_services for CX.
  SELECT COUNT(*) INTO n FROM canonical_plan_services WHERE canonical_plan_id = cp;
  ASSERT n = 0,
    'canonical_plan_services for CX = ' || n || ' (expected 0 — identity tag must NOT write service values)';
  RAISE NOTICE 'RULE#10 PASS — canonical-identity tag wrote 0 canonical_plan_services (values only via promotion)';

  RAISE NOTICE '==== ALL CORROBORATION-PS GATE (e) PART-2 ASSERTIONS PASSED ====';
END $$;

ROLLBACK;
