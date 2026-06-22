-- F.0 Phase-2 gate assertions (mig 169) — run AFTER stub + mig 165 + mig 169.
-- Proves: (1) the symmetric mirror keeps legacy+aligned twins equal regardless of which side a
-- writer sets, with aligned precedence, and never clobbers (incl. the canonical-match boolean case);
-- (2) the dropped aligned-boolean DEFAULTs; (3) bidirectional provenance twin; (4) confidence safety;
-- (5) the apply_promotion_event per-service flip writes the ALIGNED columns + provenance and mirrors
-- to legacy; (6) ON CONFLICT second-field promotion does not clobber the first; (7) coinsurance
-- normalization survives the flip. Any failure RAISES (ON_ERROR_STOP aborts the run).

-- ── T0: aligned-boolean DEFAULTs dropped ──
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name='canonical_plan_services'
     AND column_name IN ('covered','in_deductible_applies','prior_auth_required')
     AND column_default IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'T0 FAIL: % aligned boolean(s) still carry a DEFAULT', n; END IF;
  RAISE NOTICE 'T0 PASS — aligned boolean DEFAULTs dropped (covered/in_deductible_applies/prior_auth_required)';
END $$;

-- ── T1: legacy-only INSERT mirrors to aligned ──
DO $$
DECLARE r canonical_plan_services%ROWTYPE;
BEGIN
  INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, copay, is_covered)
  VALUES (gen_random_uuid(), 't1', 10, false) RETURNING * INTO r;
  IF r.in_copay <> 10 THEN RAISE EXCEPTION 'T1 FAIL: in_copay=% (want 10)', r.in_copay; END IF;
  IF r.covered <> false THEN RAISE EXCEPTION 'T1 FAIL: covered=% (want false)', r.covered; END IF;
  IF r.in_deductible_applies <> true THEN RAISE EXCEPTION 'T1 FAIL: in_deductible_applies=% (want true from legacy default)', r.in_deductible_applies; END IF;
  RAISE NOTICE 'T1 PASS — legacy-only INSERT mirrored to aligned (in_copay 10, covered false, in_ded true)';
END $$;

-- ── T2: aligned-only INSERT mirrors to legacy ──
DO $$
DECLARE r canonical_plan_services%ROWTYPE;
BEGIN
  INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, in_copay, covered)
  VALUES (gen_random_uuid(), 't2', 20, false) RETURNING * INTO r;
  IF r.copay <> 20 THEN RAISE EXCEPTION 'T2 FAIL: copay=% (want 20)', r.copay; END IF;
  IF r.is_covered <> false THEN RAISE EXCEPTION 'T2 FAIL: is_covered=% (want false)', r.is_covered; END IF;
  RAISE NOTICE 'T2 PASS — aligned-only INSERT mirrored to legacy (copay 20, is_covered false)';
END $$;

-- ── T3: both-set INSERT -> aligned precedence ──
DO $$
DECLARE r canonical_plan_services%ROWTYPE;
BEGIN
  INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, copay, in_copay)
  VALUES (gen_random_uuid(), 't3', 5, 7) RETURNING * INTO r;
  IF r.copay <> 7 OR r.in_copay <> 7 THEN RAISE EXCEPTION 'T3 FAIL: copay=% in_copay=% (want both 7, aligned wins)', r.copay, r.in_copay; END IF;
  RAISE NOTICE 'T3 PASS — both-set INSERT, aligned precedence (both 7)';
END $$;

-- ── T4: legacy UPDATE propagates to aligned ──
DO $$
DECLARE id0 UUID; v NUMERIC;
BEGIN
  INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, in_copay) VALUES (gen_random_uuid(), 't4', 1) RETURNING id INTO id0;
  UPDATE canonical_plan_services SET copay = 30 WHERE id = id0;
  SELECT in_copay INTO v FROM canonical_plan_services WHERE id = id0;
  IF v <> 30 THEN RAISE EXCEPTION 'T4 FAIL: in_copay=% after legacy UPDATE (want 30)', v; END IF;
  RAISE NOTICE 'T4 PASS — legacy UPDATE propagated to aligned (in_copay 30)';
END $$;

-- ── T5: aligned UPDATE propagates to legacy ──
DO $$
DECLARE id0 UUID; v NUMERIC;
BEGIN
  INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, in_copay) VALUES (gen_random_uuid(), 't5', 1) RETURNING id INTO id0;
  UPDATE canonical_plan_services SET in_copay = 40 WHERE id = id0;
  SELECT copay INTO v FROM canonical_plan_services WHERE id = id0;
  IF v <> 40 THEN RAISE EXCEPTION 'T5 FAIL: copay=% after aligned UPDATE (want 40)', v; END IF;
  RAISE NOTICE 'T5 PASS — aligned UPDATE propagated to legacy (copay 40)';
END $$;

-- ── T6: unrelated UPDATE does not disturb the pair (no clobber) ──
DO $$
DECLARE id0 UUID; c NUMERIC; ic NUMERIC;
BEGIN
  INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, in_copay) VALUES (gen_random_uuid(), 't6', 55) RETURNING id INTO id0;
  UPDATE canonical_plan_services SET service_slug = 't6b' WHERE id = id0;
  SELECT copay, in_copay INTO c, ic FROM canonical_plan_services WHERE id = id0;
  IF c <> 55 OR ic <> 55 THEN RAISE EXCEPTION 'T6 FAIL: copay=% in_copay=% after unrelated UPDATE (want both 55)', c, ic; END IF;
  RAISE NOTICE 'T6 PASS — unrelated UPDATE left the pair intact (both 55)';
END $$;

-- ── T7: canonical-match clobber-safety — is_covered=false omit covered -> covered false (NOT default true) ──
DO $$
DECLARE r canonical_plan_services%ROWTYPE;
BEGIN
  -- exactly the mergeCanonicalServices shape before the code flip: writes legacy is_covered=false, omits covered
  INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, copay, coinsurance, is_covered, requires_prior_auth, deductible_applies)
  VALUES (gen_random_uuid(), 't7', 25, 0.2, false, true, false) RETURNING * INTO r;
  IF r.covered <> false THEN RAISE EXCEPTION 'T7 FAIL: covered=% (want false — the one-directional swap would have clobbered to true)', r.covered; END IF;
  IF r.prior_auth_required <> true THEN RAISE EXCEPTION 'T7 FAIL: prior_auth_required=% (want true)', r.prior_auth_required; END IF;
  IF r.in_deductible_applies <> false THEN RAISE EXCEPTION 'T7 FAIL: in_deductible_applies=% (want false)', r.in_deductible_applies; END IF;
  RAISE NOTICE 'T7 PASS — legacy-only canonical-match INSERT mirrored cleanly (covered false, pa true, in_ded false) — NO clobber';
END $$;

-- ── T8: bidirectional provenance twin (aligned precedence) ──
DO $$
DECLARE r canonical_plan_services%ROWTYPE;
BEGIN
  -- write under aligned key -> legacy twin appears
  INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, in_copay, field_provenance)
  VALUES (gen_random_uuid(), 't8a', 40, '{"in_copay":{"value":40,"confidence":0.9}}'::jsonb) RETURNING * INTO r;
  IF r.field_provenance->'copay' IS NULL OR (r.field_provenance->'copay') <> (r.field_provenance->'in_copay') THEN
    RAISE EXCEPTION 'T8a FAIL: copay twin missing/unequal: %', r.field_provenance; END IF;
  -- write under legacy key -> aligned twin appears
  INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, copay, field_provenance)
  VALUES (gen_random_uuid(), 't8b', 15, '{"copay":{"value":15,"confidence":0.9}}'::jsonb) RETURNING * INTO r;
  IF r.field_provenance->'in_copay' IS NULL OR (r.field_provenance->'in_copay') <> (r.field_provenance->'copay') THEN
    RAISE EXCEPTION 'T8b FAIL: in_copay twin missing/unequal: %', r.field_provenance; END IF;
  RAISE NOTICE 'T8 PASS — provenance twinned bidirectionally (in_copay<->copay equal)';
END $$;

-- ── T9: confidence recompute unchanged by twinning (MIN over equal-confidence twins) ──
DO $$
DECLARE r canonical_plan_services%ROWTYPE;
BEGIN
  INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, in_copay, field_provenance)
  VALUES (gen_random_uuid(), 't9', 40, '{"in_copay":{"value":40,"confidence":0.9}}'::jsonb) RETURNING * INTO r;
  IF r.confidence <> 0.9 THEN RAISE EXCEPTION 'T9 FAIL: confidence=% (want 0.9 — twin must not perturb MIN)', r.confidence; END IF;
  RAISE NOTICE 'T9 PASS — confidence 0.9 (bidirectional twin carries identical confidence)';
END $$;

-- ════════════════ apply_promotion_event (per-service flip) ════════════════

-- ── T10: first promotion under in_copay writes aligned column + provenance + legacy mirror ──
DO $$
DECLARE cp UUID := gen_random_uuid(); r canonical_plan_services%ROWTYPE;
BEGIN
  PERFORM apply_promotion_event(cp, 'surgery', 'in_copay', '40'::jsonb,
    '[{"user_id_hash":"u1","recorded_at":"2026-01-01T00:00:00Z"}]'::jsonb, 'test');
  SELECT * INTO r FROM canonical_plan_services WHERE canonical_plan_id=cp AND service_slug='surgery';
  IF r.in_copay <> 40 THEN RAISE EXCEPTION 'T10 FAIL: in_copay=% (want 40)', r.in_copay; END IF;
  IF r.copay <> 40 THEN RAISE EXCEPTION 'T10 FAIL: copay mirror=% (want 40)', r.copay; END IF;
  IF (r.field_provenance->'in_copay'->>'value') <> '40' THEN RAISE EXCEPTION 'T10 FAIL: in_copay prov value=%', r.field_provenance->'in_copay'->>'value'; END IF;
  IF (r.field_provenance->'copay'->>'value') <> '40' THEN RAISE EXCEPTION 'T10 FAIL: copay prov twin value=%', r.field_provenance->'copay'->>'value'; END IF;
  IF r.confidence <> 0.9 THEN RAISE EXCEPTION 'T10 FAIL: confidence=%', r.confidence; END IF;
  RAISE NOTICE 'T10 PASS — promote in_copay -> in_copay=40, copay mirror=40, prov twinned, conf 0.9';
END $$;

-- ── T11: promotion under covered (boolean false) ──
DO $$
DECLARE cp UUID := gen_random_uuid(); r canonical_plan_services%ROWTYPE;
BEGIN
  PERFORM apply_promotion_event(cp, 'mri', 'covered', 'false'::jsonb,
    '[{"user_id_hash":"u1","recorded_at":"2026-01-01T00:00:00Z"}]'::jsonb, 'test');
  SELECT * INTO r FROM canonical_plan_services WHERE canonical_plan_id=cp AND service_slug='mri';
  IF r.covered <> false THEN RAISE EXCEPTION 'T11 FAIL: covered=% (want false)', r.covered; END IF;
  IF r.is_covered <> false THEN RAISE EXCEPTION 'T11 FAIL: is_covered mirror=% (want false)', r.is_covered; END IF;
  RAISE NOTICE 'T11 PASS — promote covered=false -> covered=false, is_covered mirror=false';
END $$;

-- ── T12: coinsurance normalization survives the flip (raw 40 -> 0.4) ──
DO $$
DECLARE cp UUID := gen_random_uuid(); r canonical_plan_services%ROWTYPE;
BEGIN
  PERFORM apply_promotion_event(cp, 'pt', 'in_coinsurance', '40'::jsonb,
    '[{"user_id_hash":"u1","recorded_at":"2026-01-01T00:00:00Z"}]'::jsonb, 'test');
  SELECT * INTO r FROM canonical_plan_services WHERE canonical_plan_id=cp AND service_slug='pt';
  IF r.in_coinsurance <> 0.4 THEN RAISE EXCEPTION 'T12 FAIL: in_coinsurance=% (want 0.4 from raw 40)', r.in_coinsurance; END IF;
  IF r.coinsurance <> 0.4 THEN RAISE EXCEPTION 'T12 FAIL: coinsurance mirror=% (want 0.4)', r.coinsurance; END IF;
  RAISE NOTICE 'T12 PASS — in_coinsurance normalized 40 -> 0.4, mirrored to legacy';
END $$;

-- ── T13: ON CONFLICT second-field promotion does not clobber the first ──
DO $$
DECLARE cp UUID := gen_random_uuid(); r canonical_plan_services%ROWTYPE;
BEGIN
  PERFORM apply_promotion_event(cp, 'colonoscopy', 'in_copay', '60'::jsonb, '[{"user_id_hash":"u1","recorded_at":"2026-01-01T00:00:00Z"}]'::jsonb, 'test');
  PERFORM apply_promotion_event(cp, 'colonoscopy', 'prior_auth_required', 'true'::jsonb, '[{"user_id_hash":"u2","recorded_at":"2026-01-02T00:00:00Z"}]'::jsonb, 'test');
  SELECT * INTO r FROM canonical_plan_services WHERE canonical_plan_id=cp AND service_slug='colonoscopy';
  IF r.in_copay <> 60 THEN RAISE EXCEPTION 'T13 FAIL: in_copay=% after 2nd-field promote (want 60 — not clobbered)', r.in_copay; END IF;
  IF r.prior_auth_required <> true THEN RAISE EXCEPTION 'T13 FAIL: prior_auth_required=% (want true)', r.prior_auth_required; END IF;
  IF r.requires_prior_auth <> true THEN RAISE EXCEPTION 'T13 FAIL: requires_prior_auth mirror=% (want true)', r.requires_prior_auth; END IF;
  IF (r.field_provenance->'in_copay'->>'value') <> '60' THEN RAISE EXCEPTION 'T13 FAIL: in_copay prov lost'; END IF;
  RAISE NOTICE 'T13 PASS — 2nd-field promote kept in_copay=60 + added prior_auth_required=true (no clobber)';
END $$;

-- ── T14: legacy field-name no longer writes a typed column (the flip moved the match point cleanly) ──
DO $$
DECLARE cp UUID := gen_random_uuid(); r canonical_plan_services%ROWTYPE;
BEGIN
  -- a caller passing the LEGACY name 'copay' must NOT write the typed column (CASE now matches 'in_copay').
  -- Part 1 made every real caller emit aligned names; this asserts there is no lingering double-match.
  PERFORM apply_promotion_event(cp, 'xray', 'copay', '99'::jsonb, '[{"user_id_hash":"u1","recorded_at":"2026-01-01T00:00:00Z"}]'::jsonb, 'test');
  SELECT * INTO r FROM canonical_plan_services WHERE canonical_plan_id=cp AND service_slug='xray';
  IF r.in_copay IS NOT NULL OR r.copay IS NOT NULL THEN
    RAISE EXCEPTION 'T14 FAIL: legacy field-name wrote a typed column (in_copay=%, copay=%) — double-match', r.in_copay, r.copay; END IF;
  RAISE NOTICE 'T14 PASS — legacy field-name writes provenance only, no typed-col double-match (callers must use aligned)';
END $$;

SELECT '>>> CANONICAL-FIELD-ALIGN PHASE-2 FIXTURE: ALL ASSERTIONS PASSED <<<' AS result;
