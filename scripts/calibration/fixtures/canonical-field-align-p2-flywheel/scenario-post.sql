-- F.0 Phase-2 FLYWHEEL A/B — MEASURE B (POST-alignment).
-- Runs AFTER mig 165 + backfill (twin) + mig 169. The SAME cold-start row now carries the in_copay
-- provenance twin, so the evaluator under the SAME aligned name (in_copay) now reads BOTH sides.

DO $$
DECLARE cp CONSTANT UUID := 'c9000001-0000-0000-0000-000000000001'; r JSONB;
BEGIN
  r := evaluate_pattern1_corroboration(cp, 'surgery', 'in_copay', NULL, NULL);
  INSERT INTO _ab_results VALUES ('POST-alignment', 'in_copay', r);
  ASSERT (r->>'distinct_user_count')::int = 3,            'POST in_copay users=' || (r->>'distinct_user_count');
  ASSERT (r->>'canonical_current_value') = '40',         'POST in_copay canonical should read 40 (twin), got ' || COALESCE(r->>'canonical_current_value','NULL');
  ASSERT (r->>'should_promote')::boolean = FALSE,         'POST in_copay should_promote should be FALSE (sees the 0.9 cold-start)';
  ASSERT (r->>'should_append_source')::boolean = TRUE,    'POST in_copay should_append should be TRUE';
  ASSERT (r->>'value_matches_canonical')::boolean = TRUE, 'POST in_copay value_matches should be TRUE';
  RAISE NOTICE 'MEASURE B (in_copay): users=3 · canonical=40 · should_promote=FALSE · should_append=TRUE · value_matches=TRUE — ONE name reads BOTH; the 3 users are confirmed to AGREE with the 0.9 cold-start → append corroboration, do NOT re-promote.';
END $$;

-- the alignment must not perturb the canonical confidence (the twin carries identical 0.9)
DO $$
DECLARE c NUMERIC;
BEGIN
  SELECT confidence INTO c FROM canonical_plan_services WHERE service_slug = 'surgery';
  ASSERT c = 0.9, 'POST canonical confidence should stay 0.9, got ' || c;
  RAISE NOTICE 'confidence preserved (0.9) through the twin';
END $$;

\echo ''
\echo '================= F.0 PHASE-2 FLYWHEEL A/B (same evaluator, same in_copay candidate) ================='
SELECT phase,
       decision->>'distinct_user_count'     AS users,
       decision->>'canonical_current_value' AS canonical_val,
       decision->>'should_promote'          AS should_promote,
       decision->>'should_append_source'    AS should_append,
       decision->>'value_matches_canonical' AS value_matches
FROM _ab_results WHERE field = 'in_copay' ORDER BY phase;
\echo 'Improvement: F.0 makes the cold-start readable under the candidate name -> the decision flips from'
\echo '"blindly re-promote over the 0.9 reference" (should_promote TRUE, canonical NULL) to "recognise + append'
\echo 'corroboration to the matching reference" (should_promote FALSE, value_matches TRUE, canonical 40).'
\echo '======================================================================================================='
