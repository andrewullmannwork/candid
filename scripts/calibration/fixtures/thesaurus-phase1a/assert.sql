-- Phase 1a T1 fixture — seed + assertions for evaluate_pattern1_corroboration (mig 156).
-- PRECONDITION: schema-stub.sql + migration 156 applied to the target DB (run.sh does this).
-- NON-MUTATING: everything runs inside a transaction that ROLLBACKs at the end.
--
-- Scenario (concept C1 = pt_rehab[canonical] + physical_therapy[alias]; plan CP1; field 'copay'):
--   specialist_office/global cell : U1(pt_rehab)=20, U2(physical_therapy alias)=20, U3(pt_rehab)=20
--   outpatient_facility/global cell: U4(pt_rehab)=99            (distractor: other cell AND other value)
--   canonical rows                : (pt_rehab,specialist_office)=30 conf .5 ; (pt_rehab,outpatient_facility)=99 conf .5
-- Threshold defaults to 3 (no canonical_promotion_event_v1 / pattern1_corroboration_threshold seeded).
--
-- Proves: (A) concept-grouping preserved — value=20 reaches 3 ONLY by counting the alias sibling, with
--   NULL pos/component = mig-108 aggregate; (B) alias→canonical resolution preserved; (C) ON-path cell
--   grouping restricts the count to one cell + pins the canonical read to that cell; (D) the other cell
--   is isolated + sub-threshold; (E) response echoes pos/component.
BEGIN;

INSERT INTO service_catalog (id, slug, concept_id, canonical_for_concept) VALUES
  ('a0000001-0000-0000-0000-000000000001', 'pt_rehab',         'cc000001-0000-0000-0000-000000000001', TRUE),
  ('a0000002-0000-0000-0000-000000000002', 'physical_therapy', 'cc000001-0000-0000-0000-000000000001', FALSE);

INSERT INTO canonical_plans (id, field_provenance) VALUES
  ('c9000001-0000-0000-0000-000000000001', '{}'::jsonb);

INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, place_of_service, component, field_provenance) VALUES
  ('c9000001-0000-0000-0000-000000000001', 'pt_rehab', 'specialist_office',  'global', '{"copay":{"value":30,"confidence":0.5}}'::jsonb),
  ('c9000001-0000-0000-0000-000000000001', 'pt_rehab', 'outpatient_facility','global', '{"copay":{"value":99,"confidence":0.5}}'::jsonb);

INSERT INTO users (id, email_verified, phone_verified) VALUES
  ('d0000001-0000-0000-0000-000000000001', TRUE, TRUE),
  ('d0000002-0000-0000-0000-000000000002', TRUE, TRUE),
  ('d0000003-0000-0000-0000-000000000003', TRUE, TRUE),
  ('d0000004-0000-0000-0000-000000000004', TRUE, TRUE);

INSERT INTO insurance_plans (id, user_id, canonical_plan_id) VALUES
  ('19000001-0000-0000-0000-000000000001', 'd0000001-0000-0000-0000-000000000001', 'c9000001-0000-0000-0000-000000000001'),
  ('19000002-0000-0000-0000-000000000002', 'd0000002-0000-0000-0000-000000000002', 'c9000001-0000-0000-0000-000000000001'),
  ('19000003-0000-0000-0000-000000000003', 'd0000003-0000-0000-0000-000000000003', 'c9000001-0000-0000-0000-000000000001'),
  ('19000004-0000-0000-0000-000000000004', 'd0000004-0000-0000-0000-000000000004', 'c9000001-0000-0000-0000-000000000001');

-- copay=20 verified across the specialist_office cell via canonical (U1,U3) + alias (U2) slugs;
-- copay=99 verified for U4 in the outpatient_facility cell.
INSERT INTO plan_covered_services (insurance_plan_id, service_id, place_of_service, component, field_provenance) VALUES
  ('19000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000001', 'specialist_office',  'global', '{"copay":{"value":20,"source_excerpt":"$20 copay","source_excerpt_verified":"verified"}}'::jsonb),
  ('19000002-0000-0000-0000-000000000002', 'a0000002-0000-0000-0000-000000000002', 'specialist_office',  'global', '{"copay":{"value":20,"source_excerpt":"$20 copay","source_excerpt_verified":"verified"}}'::jsonb),
  ('19000003-0000-0000-0000-000000000003', 'a0000001-0000-0000-0000-000000000001', 'specialist_office',  'global', '{"copay":{"value":20,"source_excerpt":"$20 copay","source_excerpt_verified":"verified"}}'::jsonb),
  ('19000004-0000-0000-0000-000000000004', 'a0000001-0000-0000-0000-000000000001', 'outpatient_facility','global', '{"copay":{"value":99,"source_excerpt":"$99 copay","source_excerpt_verified":"verified"}}'::jsonb);

DO $$
DECLARE
  cp  CONSTANT UUID := 'c9000001-0000-0000-0000-000000000001';
  r   JSONB;
BEGIN
  -- A — NULL/NULL (aggregate = mig-108). Concept-grouping: value=20 reaches 3 ONLY via the alias sibling.
  r := evaluate_pattern1_corroboration(cp, 'pt_rehab', 'copay', NULL, NULL);
  ASSERT (r->>'same_value_count')::int    = 3,         'A same_value_count = '   || (r->>'same_value_count');
  ASSERT (r->>'distinct_user_count')::int = 4,         'A distinct_user_count = '|| (r->>'distinct_user_count');
  ASSERT (r->>'corroborated_value')       = '20',      'A corroborated_value = '  || COALESCE(r->>'corroborated_value','NULL');
  ASSERT (r->>'canonical_service_slug')   = 'pt_rehab','A canonical_service_slug';
  ASSERT (r->>'should_promote')::boolean  = TRUE,      'A should_promote';
  RAISE NOTICE 'A PASS — concept-grouping preserved; NULL pos/component = mig-108 aggregate';

  -- B — alias as INPUT resolves to its canonical sibling (mig-108 silent-split fix preserved).
  r := evaluate_pattern1_corroboration(cp, 'physical_therapy', 'copay', NULL, NULL);
  ASSERT (r->>'same_value_count')::int  = 3,          'B same_value_count = ' || (r->>'same_value_count');
  ASSERT (r->>'canonical_service_slug') = 'pt_rehab', 'B canonical_service_slug';
  RAISE NOTICE 'B PASS — alias->canonical resolution preserved';

  -- C — ON-path cell (specialist_office/global): excludes the outpatient distractor; canonical read pinned.
  r := evaluate_pattern1_corroboration(cp, 'pt_rehab', 'copay', 'specialist_office', 'global');
  ASSERT (r->>'distinct_user_count')::int = 3,    'C distinct_user_count = ' || (r->>'distinct_user_count');
  ASSERT (r->>'same_value_count')::int    = 3,    'C same_value_count = '    || (r->>'same_value_count');
  ASSERT (r->>'should_promote')::boolean  = TRUE, 'C should_promote';
  ASSERT (r->>'canonical_current_value')  = '30', 'C canonical pinned to specialist cell = ' || COALESCE(r->>'canonical_current_value','NULL');
  RAISE NOTICE 'C PASS — cell-restricted count; canonical read pinned to specialist_office row';

  -- D — ON-path other cell (outpatient_facility/global): only the distractor, sub-threshold; canonical pinned.
  r := evaluate_pattern1_corroboration(cp, 'pt_rehab', 'copay', 'outpatient_facility', 'global');
  ASSERT (r->>'distinct_user_count')::int = 1,     'D distinct_user_count = ' || (r->>'distinct_user_count');
  ASSERT (r->>'same_value_count')::int    = 1,     'D same_value_count = '    || (r->>'same_value_count');
  ASSERT (r->>'should_promote')::boolean  = FALSE, 'D should_promote';
  ASSERT (r->>'canonical_current_value')  = '99',  'D canonical pinned to outpatient cell = ' || COALESCE(r->>'canonical_current_value','NULL');
  RAISE NOTICE 'D PASS — other cell isolated + sub-threshold; canonical read pinned to outpatient_facility row';

  -- E — response echoes pos/component additively.
  r := evaluate_pattern1_corroboration(cp, 'pt_rehab', 'copay', 'specialist_office', 'global');
  ASSERT (r->>'place_of_service') = 'specialist_office', 'E place_of_service echo';
  ASSERT (r->>'component')        = 'global',            'E component echo';
  RAISE NOTICE 'E PASS — response echoes place_of_service + component';

  RAISE NOTICE '==== ALL THESAURUS PHASE-1A T1 CORROBORATION ASSERTIONS PASSED ====';
END $$;

ROLLBACK;
