-- S205 Corroboration-PS gate (a) — seed + assertions for evaluate_pattern1_corroboration (mig 156, UNCHANGED).
-- PRECONDITION: schema-stub.sql + migration 156 applied (run.sh does this). NON-MUTATING: ROLLBACK at end.
--
-- The F fix is a WRITE-PATH + CANDIDATE-NAME alignment, not an evaluator change. This fixture proves the
-- alignment END-TO-END against the real evaluator, using provenance shaped EXACTLY as the S205 builders now
-- write it: keyed by the plan_covered_services COLUMN name, with a `value` that mirrors the column
-- (coinsurance as the stored DECIMAL, booleans as-is).
--
-- Scenario (service 'surgery'; plan CP1; 3 email+phone-verified users U1/U2/U3 agreeing on every field):
--   in_copay=40 (number) · in_coinsurance=0.4 (DECIMAL — what normalizeCoinsuranceForStorage yields) ·
--   prior_auth_required=false (boolean) — all source_excerpt_verified='verified'.
--
-- Proves: (A) per-service corroboration FIRES on the COLUMN-name field (the S205 name-align) — count 3,
--   should_promote; (B) the PRE-S205 canonical-style alias ('copay') counts ZERO against the same data
--   (the exact 0-fire bug — negative control); (C) the DECIMAL coinsurance value corroborates (0.4, not 40);
--   (D) boolean `false` IS counted (proves the value-wiring stores false/0, not just truthy values).
BEGIN;

INSERT INTO service_catalog (id, slug, concept_id, canonical_for_concept) VALUES
  ('a0000001-0000-0000-0000-000000000001', 'surgery', 'cc000001-0000-0000-0000-000000000001', TRUE);

INSERT INTO canonical_plans (id, field_provenance) VALUES
  ('c9000001-0000-0000-0000-000000000001', '{}'::jsonb);

INSERT INTO users (id, email_verified, phone_verified) VALUES
  ('d0000001-0000-0000-0000-000000000001', TRUE, TRUE),
  ('d0000002-0000-0000-0000-000000000002', TRUE, TRUE),
  ('d0000003-0000-0000-0000-000000000003', TRUE, TRUE);

INSERT INTO insurance_plans (id, user_id, canonical_plan_id) VALUES
  ('19000001-0000-0000-0000-000000000001', 'd0000001-0000-0000-0000-000000000001', 'c9000001-0000-0000-0000-000000000001'),
  ('19000002-0000-0000-0000-000000000002', 'd0000002-0000-0000-0000-000000000002', 'c9000001-0000-0000-0000-000000000001'),
  ('19000003-0000-0000-0000-000000000003', 'd0000003-0000-0000-0000-000000000003', 'c9000001-0000-0000-0000-000000000001');

-- field_provenance keyed by COLUMN names, each carrying `value` = the stored column value
-- (coinsurance DECIMAL 0.4; PA boolean false). This is the exact shape buildPlanCoveredServiceProvenance
-- + buildProvenanceEntry now produce after S205.
INSERT INTO plan_covered_services (insurance_plan_id, service_id, place_of_service, component, field_provenance) VALUES
  ('19000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000001', 'any', 'global',
   '{"in_copay":{"value":40,"source_excerpt":"$40 copay","source_excerpt_verified":"verified"},"in_coinsurance":{"value":0.4,"source_excerpt":"40% coinsurance","source_excerpt_verified":"verified"},"prior_auth_required":{"value":false,"source_excerpt":"No prior authorization required","source_excerpt_verified":"verified"}}'::jsonb),
  ('19000002-0000-0000-0000-000000000002', 'a0000001-0000-0000-0000-000000000001', 'any', 'global',
   '{"in_copay":{"value":40,"source_excerpt":"$40 copay","source_excerpt_verified":"verified"},"in_coinsurance":{"value":0.4,"source_excerpt":"40% coinsurance","source_excerpt_verified":"verified"},"prior_auth_required":{"value":false,"source_excerpt":"No prior authorization required","source_excerpt_verified":"verified"}}'::jsonb),
  ('19000003-0000-0000-0000-000000000003', 'a0000001-0000-0000-0000-000000000001', 'any', 'global',
   '{"in_copay":{"value":40,"source_excerpt":"$40 copay","source_excerpt_verified":"verified"},"in_coinsurance":{"value":0.4,"source_excerpt":"40% coinsurance","source_excerpt_verified":"verified"},"prior_auth_required":{"value":false,"source_excerpt":"No prior authorization required","source_excerpt_verified":"verified"}}'::jsonb);

DO $$
DECLARE
  cp  CONSTANT UUID := 'c9000001-0000-0000-0000-000000000001';
  r   JSONB;
BEGIN
  -- A — COLUMN-name field 'in_copay' (the S205 candidate name): corroboration FIRES.
  r := evaluate_pattern1_corroboration(cp, 'surgery', 'in_copay', NULL, NULL);
  ASSERT (r->>'distinct_user_count')::int = 3,     'A distinct_user_count = ' || (r->>'distinct_user_count');
  ASSERT (r->>'same_value_count')::int    = 3,     'A same_value_count = '    || (r->>'same_value_count');
  ASSERT (r->>'corroborated_value')       = '40',  'A corroborated_value = '  || COALESCE(r->>'corroborated_value','NULL');
  ASSERT (r->>'should_promote')::boolean  = TRUE,  'A should_promote';
  RAISE NOTICE 'A PASS — per-service corroboration FIRES on the column-name field in_copay (count 3, promote)';

  -- B — PRE-S205 canonical-style alias 'copay' against the SAME rows: counts ZERO (the exact 0-fire bug).
  r := evaluate_pattern1_corroboration(cp, 'surgery', 'copay', NULL, NULL);
  ASSERT (r->>'distinct_user_count')::int = 0,     'B distinct_user_count = ' || (r->>'distinct_user_count');
  ASSERT (r->>'should_promote')::boolean  = FALSE, 'B should_promote';
  RAISE NOTICE 'B PASS — the old alias copay counts 0 on column-keyed provenance (the bug F fixes)';

  -- C — DECIMAL coinsurance value corroborates as 0.4 (NOT the legacy raw percent 40).
  r := evaluate_pattern1_corroboration(cp, 'surgery', 'in_coinsurance', NULL, NULL);
  ASSERT (r->>'distinct_user_count')::int = 3,      'C distinct_user_count = ' || (r->>'distinct_user_count');
  ASSERT (r->>'corroborated_value')       = '0.4',  'C corroborated_value = '  || COALESCE(r->>'corroborated_value','NULL');
  ASSERT (r->>'should_promote')::boolean  = TRUE,   'C should_promote';
  RAISE NOTICE 'C PASS — decimal coinsurance 0.4 corroborates (value-space matches the column)';

  -- D — boolean `false` IS counted (proves value-wiring stores false, not just truthy values).
  r := evaluate_pattern1_corroboration(cp, 'surgery', 'prior_auth_required', NULL, NULL);
  ASSERT (r->>'distinct_user_count')::int = 3,       'D distinct_user_count = ' || (r->>'distinct_user_count');
  ASSERT (r->>'corroborated_value')       = 'false', 'D corroborated_value = '  || COALESCE(r->>'corroborated_value','NULL');
  RAISE NOTICE 'D PASS — boolean false is a valid corroboration value (stored, counted)';

  RAISE NOTICE '==== ALL CORROBORATION-PS GATE (a) ASSERTIONS PASSED ====';
END $$;

ROLLBACK;
