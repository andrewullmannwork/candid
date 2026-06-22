-- F.0 Phase-1 PROD parity gate (READ-ONLY). Run AFTER snapshot + mig 165 + backfill.
-- Requires canonical_plan_services_pre_align_bak (from snapshot.sql). One result grid;
-- all "_mismatch"/"_changed" rows must be 0, and each twin count must equal its legacy count.
SELECT * FROM (
  -- 1. typed per-row equality (expect 0 each)
  SELECT '1_typed_mismatch'::text AS check_name, 'in_copay<>copay'::text AS metric, count(*)::text AS value FROM canonical_plan_services WHERE in_copay IS DISTINCT FROM copay
  UNION ALL SELECT '1_typed_mismatch','in_coinsurance<>coinsurance', count(*)::text FROM canonical_plan_services WHERE in_coinsurance IS DISTINCT FROM coinsurance
  UNION ALL SELECT '1_typed_mismatch','in_deductible_applies<>deductible_applies', count(*)::text FROM canonical_plan_services WHERE in_deductible_applies IS DISTINCT FROM deductible_applies
  UNION ALL SELECT '1_typed_mismatch','covered<>is_covered', count(*)::text FROM canonical_plan_services WHERE covered IS DISTINCT FROM is_covered
  UNION ALL SELECT '1_typed_mismatch','prior_auth_required<>requires_prior_auth', count(*)::text FROM canonical_plan_services WHERE prior_auth_required IS DISTINCT FROM requires_prior_auth
  -- 2. provenance twin counts must equal legacy key counts (expect: copay/in_copay 21000, coinsurance/in_ 19658, deductible_applies/in_ 47124, is_covered/covered 48548, requires_prior_auth/prior_auth_required 6308)
  UNION ALL SELECT '2_prov_count','in_copay',                       count(*)::text FROM canonical_plan_services WHERE field_provenance ? 'in_copay'
  UNION ALL SELECT '2_prov_count','copay (expect ==)',              count(*)::text FROM canonical_plan_services WHERE field_provenance ? 'copay'
  UNION ALL SELECT '2_prov_count','in_coinsurance',                count(*)::text FROM canonical_plan_services WHERE field_provenance ? 'in_coinsurance'
  UNION ALL SELECT '2_prov_count','coinsurance (expect ==)',       count(*)::text FROM canonical_plan_services WHERE field_provenance ? 'coinsurance'
  UNION ALL SELECT '2_prov_count','in_deductible_applies',         count(*)::text FROM canonical_plan_services WHERE field_provenance ? 'in_deductible_applies'
  UNION ALL SELECT '2_prov_count','deductible_applies (expect ==)',count(*)::text FROM canonical_plan_services WHERE field_provenance ? 'deductible_applies'
  UNION ALL SELECT '2_prov_count','covered',                       count(*)::text FROM canonical_plan_services WHERE field_provenance ? 'covered'
  UNION ALL SELECT '2_prov_count','is_covered (expect ==)',        count(*)::text FROM canonical_plan_services WHERE field_provenance ? 'is_covered'
  UNION ALL SELECT '2_prov_count','prior_auth_required',           count(*)::text FROM canonical_plan_services WHERE field_provenance ? 'prior_auth_required'
  UNION ALL SELECT '2_prov_count','requires_prior_auth (expect ==)',count(*)::text FROM canonical_plan_services WHERE field_provenance ? 'requires_prior_auth'
  -- 3. twin VALUE byte-equality (expect 0 each)
  UNION ALL SELECT '3_prov_value_mismatch','in_copay<>copay',                           count(*)::text FROM canonical_plan_services WHERE (field_provenance ? 'copay')               AND field_provenance->'in_copay'              IS DISTINCT FROM field_provenance->'copay'
  UNION ALL SELECT '3_prov_value_mismatch','in_coinsurance<>coinsurance',               count(*)::text FROM canonical_plan_services WHERE (field_provenance ? 'coinsurance')         AND field_provenance->'in_coinsurance'        IS DISTINCT FROM field_provenance->'coinsurance'
  UNION ALL SELECT '3_prov_value_mismatch','in_deductible_applies<>deductible_applies', count(*)::text FROM canonical_plan_services WHERE (field_provenance ? 'deductible_applies')  AND field_provenance->'in_deductible_applies' IS DISTINCT FROM field_provenance->'deductible_applies'
  UNION ALL SELECT '3_prov_value_mismatch','covered<>is_covered',                       count(*)::text FROM canonical_plan_services WHERE (field_provenance ? 'is_covered')          AND field_provenance->'covered'               IS DISTINCT FROM field_provenance->'is_covered'
  UNION ALL SELECT '3_prov_value_mismatch','prior_auth_required<>requires_prior_auth',  count(*)::text FROM canonical_plan_services WHERE (field_provenance ? 'requires_prior_auth') AND field_provenance->'prior_auth_required'   IS DISTINCT FROM field_provenance->'requires_prior_auth'
  -- 4. confidence unchanged vs snapshot (expect 0) + row-count integrity
  UNION ALL SELECT '4_confidence_changed','vs pre_align_bak', count(*)::text FROM canonical_plan_services c JOIN canonical_plan_services_pre_align_bak b USING (id) WHERE c.confidence IS DISTINCT FROM b.confidence
  UNION ALL SELECT '5_rowcount','live',                count(*)::text FROM canonical_plan_services
  UNION ALL SELECT '5_rowcount','snapshot (expect ==)', count(*)::text FROM canonical_plan_services_pre_align_bak
) q ORDER BY check_name, metric;
