-- F.0 Phase-1 fixture assertions. Run after: stub -> seed(pre-mig) -> mig165 -> backfill(x2).
-- _after1 = snapshot taken between the two backfill runs (idempotency oracle, created in run.sh).

DO $$
DECLARE n int;
BEGIN
  -- 1. typed mirror on every row
  SELECT count(*) INTO n FROM canonical_plan_services
   WHERE in_copay IS DISTINCT FROM copay
      OR in_coinsurance IS DISTINCT FROM coinsurance
      OR in_deductible_applies IS DISTINCT FROM deductible_applies
      OR covered IS DISTINCT FROM is_covered
      OR prior_auth_required IS DISTINCT FROM requires_prior_auth;
  IF n <> 0 THEN RAISE EXCEPTION '1 typed-mirror FAIL: % mismatched rows', n; END IF;
  RAISE NOTICE '1 PASS typed mirror (in_copay=copay, in_coinsurance=coinsurance, covered=is_covered, prior_auth_required=requires_prior_auth, in_deductible_applies=deductible_applies)';

  -- 2. provenance twin present wherever the legacy in-net key exists
  SELECT count(*) INTO n FROM canonical_plan_services WHERE (field_provenance ? 'copay')               AND NOT (field_provenance ? 'in_copay');               IF n<>0 THEN RAISE EXCEPTION '2a in_copay twin missing (% rows)', n; END IF;
  SELECT count(*) INTO n FROM canonical_plan_services WHERE (field_provenance ? 'coinsurance')         AND NOT (field_provenance ? 'in_coinsurance');         IF n<>0 THEN RAISE EXCEPTION '2b in_coinsurance twin missing (% rows)', n; END IF;
  SELECT count(*) INTO n FROM canonical_plan_services WHERE (field_provenance ? 'deductible_applies')  AND NOT (field_provenance ? 'in_deductible_applies');  IF n<>0 THEN RAISE EXCEPTION '2c in_deductible_applies twin missing (% rows)', n; END IF;
  SELECT count(*) INTO n FROM canonical_plan_services WHERE (field_provenance ? 'is_covered')          AND NOT (field_provenance ? 'covered');                IF n<>0 THEN RAISE EXCEPTION '2d covered twin missing (% rows)', n; END IF;
  SELECT count(*) INTO n FROM canonical_plan_services WHERE (field_provenance ? 'requires_prior_auth') AND NOT (field_provenance ? 'prior_auth_required');    IF n<>0 THEN RAISE EXCEPTION '2e prior_auth_required twin missing (% rows)', n; END IF;
  RAISE NOTICE '2 PASS provenance twins present wherever the legacy key exists';

  -- 3. twin VALUE byte-equal to its legacy entry
  SELECT count(*) INTO n FROM canonical_plan_services WHERE (field_provenance ? 'copay')               AND field_provenance->'in_copay'              IS DISTINCT FROM field_provenance->'copay';               IF n<>0 THEN RAISE EXCEPTION '3a in_copay value != copay (% rows)', n; END IF;
  SELECT count(*) INTO n FROM canonical_plan_services WHERE (field_provenance ? 'coinsurance')         AND field_provenance->'in_coinsurance'        IS DISTINCT FROM field_provenance->'coinsurance';         IF n<>0 THEN RAISE EXCEPTION '3b in_coinsurance value != coinsurance (% rows)', n; END IF;
  SELECT count(*) INTO n FROM canonical_plan_services WHERE (field_provenance ? 'deductible_applies')  AND field_provenance->'in_deductible_applies' IS DISTINCT FROM field_provenance->'deductible_applies';  IF n<>0 THEN RAISE EXCEPTION '3c in_deductible_applies value != deductible_applies (% rows)', n; END IF;
  SELECT count(*) INTO n FROM canonical_plan_services WHERE (field_provenance ? 'is_covered')          AND field_provenance->'covered'               IS DISTINCT FROM field_provenance->'is_covered';          IF n<>0 THEN RAISE EXCEPTION '3d covered value != is_covered (% rows)', n; END IF;
  SELECT count(*) INTO n FROM canonical_plan_services WHERE (field_provenance ? 'requires_prior_auth') AND field_provenance->'prior_auth_required'   IS DISTINCT FROM field_provenance->'requires_prior_auth';  IF n<>0 THEN RAISE EXCEPTION '3e prior_auth_required value != requires_prior_auth (% rows)', n; END IF;
  RAISE NOTICE '3 PASS twin values byte-equal to legacy entries';

  -- 4. confidence byte-identical vs pre-align snapshot (the trigger-safety invariant)
  SELECT count(*) INTO n FROM canonical_plan_services c JOIN _pre_conf p USING (id) WHERE c.confidence IS DISTINCT FROM p.confidence;
  IF n <> 0 THEN RAISE EXCEPTION '4 confidence CHANGED on % rows (MIN perturbed)', n; END IF;
  RAISE NOTICE '4 PASS confidence byte-identical pre/post (row_c stays 0.7, row_d 0.8, row_e 0.5, A/B 0.9)';

  -- 5. out_* untouched: row_d out_copay intact (40) + in_copay twin came from copay(15), not out_copay
  SELECT count(*) INTO n FROM canonical_plan_services
   WHERE service_slug='row_d_out'
     AND field_provenance->'out_copay'->>'value' = '40'
     AND field_provenance->'in_copay'->>'value'  = '15'
     AND (field_provenance ? 'copay');
  IF n <> 1 THEN RAISE EXCEPTION '5 out_* handling FAIL on row_d (out_copay perturbed or in_copay sourced wrong)'; END IF;
  RAISE NOTICE '5 PASS out_* untouched (no twin spawned from out_copay; out_copay value intact)';

  -- 6. idempotency: current state identical to the snapshot after the FIRST backfill run
  SELECT count(*) INTO n FROM canonical_plan_services c JOIN _after1 a USING (id)
   WHERE c.field_provenance IS DISTINCT FROM a.field_provenance
      OR c.in_copay IS DISTINCT FROM a.in_copay OR c.in_coinsurance IS DISTINCT FROM a.in_coinsurance
      OR c.in_deductible_applies IS DISTINCT FROM a.in_deductible_applies
      OR c.covered IS DISTINCT FROM a.covered OR c.prior_auth_required IS DISTINCT FROM a.prior_auth_required
      OR c.confidence IS DISTINCT FROM a.confidence;
  IF n <> 0 THEN RAISE EXCEPTION '6 idempotency FAIL: % rows changed on 2nd backfill', n; END IF;
  RAISE NOTICE '6 PASS backfill idempotent (run2 == run1)';
END $$;

-- 7. dual-write TRIGGER path: a fresh post-mig INSERT setting ONLY legacy cols/keys must auto-mirror
INSERT INTO canonical_plan_services (service_slug, copay, is_covered, requires_prior_auth, field_provenance)
VALUES ('row_f_trigger', 25, false, true,
  '{"copay":{"value":25,"confidence":0.95},"is_covered":{"value":false,"confidence":0.95},"requires_prior_auth":{"value":true,"confidence":0.95}}');
DO $$
DECLARE r canonical_plan_services%ROWTYPE;
BEGIN
  SELECT * INTO r FROM canonical_plan_services WHERE service_slug='row_f_trigger';
  IF r.in_copay IS DISTINCT FROM 25 OR r.covered IS DISTINCT FROM false OR r.prior_auth_required IS DISTINCT FROM true
     THEN RAISE EXCEPTION '7 trigger typed-mirror FAIL on INSERT (in_copay=% covered=% pa=%)', r.in_copay, r.covered, r.prior_auth_required; END IF;
  IF NOT (r.field_provenance ? 'in_copay') OR NOT (r.field_provenance ? 'covered') OR NOT (r.field_provenance ? 'prior_auth_required')
     THEN RAISE EXCEPTION '7 trigger provenance-twin FAIL on INSERT'; END IF;
  IF r.confidence IS DISTINCT FROM 0.95 THEN RAISE EXCEPTION '7 trigger confidence FAIL (%)', r.confidence; END IF;
  RAISE NOTICE '7 PASS dual-write trigger mirrors a fresh legacy-only INSERT (typed + provenance twins + confidence 0.95)';
END $$;

-- 8. fire-order: both triggers present; align_dualwrite sorts BEFORE confidence_recompute
DO $$
DECLARE names text;
BEGIN
  SELECT string_agg(tgname, ',' ORDER BY tgname) INTO names FROM pg_trigger
   WHERE tgrelid='canonical_plan_services'::regclass AND NOT tgisinternal;
  IF position('canonical_plan_services_align_dualwrite' in names)=0 OR position('canonical_plan_services_confidence_recompute' in names)=0
     THEN RAISE EXCEPTION '8 missing trigger(s): %', names; END IF;
  IF position('canonical_plan_services_align_dualwrite' in names) > position('canonical_plan_services_confidence_recompute' in names)
     THEN RAISE EXCEPTION '8 fire-order WRONG (align must sort before confidence): %', names; END IF;
  RAISE NOTICE '8 PASS both triggers present; align_dualwrite fires before confidence_recompute';
END $$;

DO $$ BEGIN RAISE NOTICE '==== ALL CANONICAL-FIELD-ALIGN PHASE-1 ASSERTIONS PASSED ===='; END $$;
