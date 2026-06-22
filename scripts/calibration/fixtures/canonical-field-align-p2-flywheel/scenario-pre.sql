-- F.0 Phase-2 FLYWHEEL A/B — seed + MEASURE A (PRE-alignment).
-- Scenario: service 'surgery', canonical plan CP1, 3 email+phone-verified users who all independently
-- report in_copay=40, AND a cold-start canonical reference (admin-attested, confidence 0.9, value 40)
-- keyed the LEGACY way ('copay'). This is the real PROD shape before F.0.
-- Runs AFTER the stub + mig 156 (evaluator) + BEFORE mig 165/169 (so canonical has no in_copay twin yet).

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

-- user side: keyed by the aligned COLUMN name in_copay (what Part 1's candidates + builders emit)
INSERT INTO plan_covered_services (insurance_plan_id, service_id, place_of_service, component, field_provenance) VALUES
  ('19000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000001', 'any', 'global',
   '{"in_copay":{"value":40,"source_excerpt":"$40 copay","source_excerpt_verified":"verified"}}'::jsonb),
  ('19000002-0000-0000-0000-000000000002', 'a0000001-0000-0000-0000-000000000001', 'any', 'global',
   '{"in_copay":{"value":40,"source_excerpt":"$40 copay","source_excerpt_verified":"verified"}}'::jsonb),
  ('19000003-0000-0000-0000-000000000003', 'a0000001-0000-0000-0000-000000000001', 'any', 'global',
   '{"in_copay":{"value":40,"source_excerpt":"$40 copay","source_excerpt_verified":"verified"}}'::jsonb);

-- cold-start canonical reference: admin-attested 0.9, value 40, keyed the LEGACY way ('copay').
INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, place_of_service, component, copay, field_provenance) VALUES
  ('c9000001-0000-0000-0000-000000000001', 'surgery', 'any', 'global', 40,
   '{"copay":{"value":40,"confidence":0.9,"source":"admin_attested"}}'::jsonb);

CREATE TABLE _ab_results (phase TEXT, field TEXT, decision JSONB);

DO $$
DECLARE cp CONSTANT UUID := 'c9000001-0000-0000-0000-000000000001'; r JSONB; r2 JSONB;
BEGIN
  -- MEASURE A — under the aligned candidate name in_copay (the name Part 1 emits)
  r := evaluate_pattern1_corroboration(cp, 'surgery', 'in_copay', NULL, NULL);
  INSERT INTO _ab_results VALUES ('PRE-alignment', 'in_copay', r);
  ASSERT (r->>'distinct_user_count')::int = 3,             'PRE in_copay users=' || (r->>'distinct_user_count');
  ASSERT (r->>'canonical_current_value') IS NULL,          'PRE in_copay canonical should be NULL (blind), got ' || COALESCE(r->>'canonical_current_value','NULL');
  ASSERT (r->>'should_promote')::boolean = TRUE,           'PRE in_copay should_promote should be TRUE';
  ASSERT (r->>'should_append_source')::boolean = FALSE,    'PRE in_copay should_append should be FALSE';
  ASSERT (r->>'value_matches_canonical')::boolean = FALSE, 'PRE in_copay value_matches should be FALSE';
  RAISE NOTICE 'MEASURE A (in_copay): users=3 · canonical=NULL · should_promote=TRUE — evaluator BLIND to the 0.9 cold-start; it would re-promote (first_promotion) OVER the admin-attested reference.';

  -- the cross-table bug: the LEGACY name reads the cold-start but misses the users
  r2 := evaluate_pattern1_corroboration(cp, 'surgery', 'copay', NULL, NULL);
  INSERT INTO _ab_results VALUES ('PRE-alignment', 'copay', r2);
  ASSERT (r2->>'distinct_user_count')::int = 0,            'PRE copay users should be 0';
  ASSERT (r2->>'canonical_current_value') = '40',         'PRE copay canonical should read 40';
  RAISE NOTICE 'MEASURE A (copay): users=0 · canonical=40 — the legacy name reads the cold-start but misses the users. NO single field name reads BOTH → per-service corroboration can never engage the reference.';
END $$;
