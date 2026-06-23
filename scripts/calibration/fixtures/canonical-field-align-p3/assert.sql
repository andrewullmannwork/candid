-- F.0 Phase-3 gate assertions (mig 173) — run AFTER stub + mig 165 + mig 169 + mig 173.
-- Proves the DORMANT one-directional legacy->aligned net that FREEZES the legacy columns:
--   (A1) aligned-only write FREEZES legacy (no aligned->legacy mirror);
--   (A2) legacy-only write still mirrors UP to aligned (the dormant net);
--   (A3) aligned UPDATE leaves legacy frozen; (A4) legacy UPDATE still propagates up;
--   (A5) provenance IS-DISTINCT-FROM-OLD guard — a stale legacy key does NOT clobber a fresh aligned write;
--   (A6) apply_promotion_event writes the aligned column with legacy now FROZEN (no mirror, no prov twin);
--   (A7) confidence recompute intact. Any failure RAISES (ON_ERROR_STOP aborts the run).

-- ── A1: aligned-only INSERT FREEZES legacy (no aligned->legacy mirror) ──
DO $$
DECLARE r canonical_plan_services%ROWTYPE;
BEGIN
  INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, in_copay, in_coinsurance, covered)
  VALUES (gen_random_uuid(), 'a1', 20, 0.3, false) RETURNING * INTO r;
  -- numerics have no DEFAULT -> frozen as NULL (proves no aligned->legacy mirror)
  IF r.copay IS NOT NULL THEN RAISE EXCEPTION 'A1 FAIL: copay=% (want NULL — frozen, not mirrored from in_copay)', r.copay; END IF;
  IF r.coinsurance IS NOT NULL THEN RAISE EXCEPTION 'A1 FAIL: coinsurance=% (want NULL — frozen)', r.coinsurance; END IF;
  -- legacy bool keeps its OWN default (true), NOT mirrored from covered=false
  IF r.is_covered <> true THEN RAISE EXCEPTION 'A1 FAIL: is_covered=% (want true=default — proves NOT mirrored from covered=false)', r.is_covered; END IF;
  -- aligned values intact
  IF r.in_copay <> 20 OR r.in_coinsurance <> 0.3 OR r.covered <> false THEN RAISE EXCEPTION 'A1 FAIL: aligned values not intact (in_copay=%, in_coins=%, covered=%)', r.in_copay, r.in_coinsurance, r.covered; END IF;
  RAISE NOTICE 'A1 PASS — aligned-only INSERT froze legacy (copay/coinsurance NULL; is_covered stays default true, not mirrored from covered=false)';
END $$;

-- ── A2: legacy-only INSERT still mirrors UP to aligned (the dormant net) ──
DO $$
DECLARE r canonical_plan_services%ROWTYPE;
BEGIN
  INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, copay, coinsurance, is_covered)
  VALUES (gen_random_uuid(), 'a2', 10, 0.2, false) RETURNING * INTO r;
  IF r.in_copay <> 10 THEN RAISE EXCEPTION 'A2 FAIL: in_copay=% (want 10 — net mirrored from legacy copay)', r.in_copay; END IF;
  IF r.in_coinsurance <> 0.2 THEN RAISE EXCEPTION 'A2 FAIL: in_coinsurance=% (want 0.2)', r.in_coinsurance; END IF;
  IF r.covered <> false THEN RAISE EXCEPTION 'A2 FAIL: covered=% (want false — net mirrored from is_covered)', r.covered; END IF;
  RAISE NOTICE 'A2 PASS — legacy-only INSERT mirrored UP to aligned (dormant net: in_copay 10, in_coins 0.2, covered false)';
END $$;

-- ── A3: aligned UPDATE leaves legacy FROZEN (no propagation down) ──
DO $$
DECLARE id0 UUID; c NUMERIC;
BEGIN
  INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, in_copay) VALUES (gen_random_uuid(), 'a3', 1) RETURNING id INTO id0;
  -- after insert: in_copay=1, copay=NULL (frozen)
  UPDATE canonical_plan_services SET in_copay = 40 WHERE id = id0;
  SELECT copay INTO c FROM canonical_plan_services WHERE id = id0;
  IF c IS NOT NULL THEN RAISE EXCEPTION 'A3 FAIL: copay=% after aligned UPDATE (want NULL — frozen, not propagated)', c; END IF;
  RAISE NOTICE 'A3 PASS — aligned UPDATE left legacy frozen (copay still NULL)';
END $$;

-- ── A4: legacy UPDATE still propagates UP to aligned (the dormant net) ──
DO $$
DECLARE id0 UUID; v NUMERIC;
BEGIN
  INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, in_copay) VALUES (gen_random_uuid(), 'a4', 1) RETURNING id INTO id0;
  UPDATE canonical_plan_services SET copay = 30 WHERE id = id0;
  SELECT in_copay INTO v FROM canonical_plan_services WHERE id = id0;
  IF v <> 30 THEN RAISE EXCEPTION 'A4 FAIL: in_copay=% after legacy UPDATE (want 30 — net propagated up)', v; END IF;
  RAISE NOTICE 'A4 PASS — legacy UPDATE propagated UP to aligned (in_copay 30, dormant net)';
END $$;

-- ── A5: provenance stale-clobber guard — a stale legacy key must NOT overwrite a fresh aligned write ──
DO $$
DECLARE id0 UUID; v TEXT;
BEGIN
  -- seed a backfilled-style row: BOTH provenance keys twinned at 40
  INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, in_copay, field_provenance)
  VALUES (gen_random_uuid(), 'a5', 40, '{"in_copay":{"value":40,"confidence":0.9},"copay":{"value":40,"confidence":0.9}}'::jsonb)
  RETURNING id INTO id0;
  -- fresh ALIGNED-only provenance update: bump in_copay to 50, leave the legacy copay key stale at 40
  UPDATE canonical_plan_services
     SET field_provenance = jsonb_set(field_provenance, '{in_copay}', '{"value":50,"confidence":0.9}'::jsonb)
   WHERE id = id0;
  SELECT field_provenance->'in_copay'->>'value' INTO v FROM canonical_plan_services WHERE id = id0;
  IF v <> '50' THEN RAISE EXCEPTION 'A5 FAIL: in_copay prov=% after aligned update (want 50 — a stale legacy copay key must NOT clobber it)', v; END IF;
  RAISE NOTICE 'A5 PASS — IS-DISTINCT-FROM-OLD guard held: stale legacy provenance key did NOT clobber the fresh aligned write (in_copay=50)';
END $$;

-- ── A6: apply_promotion_event writes the ALIGNED column; legacy now FROZEN (no mirror, no prov twin) ──
DO $$
DECLARE cp UUID := gen_random_uuid(); r canonical_plan_services%ROWTYPE;
BEGIN
  PERFORM apply_promotion_event(cp, 'surgery', 'in_copay', '40'::jsonb,
    '[{"user_id_hash":"u1","recorded_at":"2026-01-01T00:00:00Z"}]'::jsonb, 'test');
  SELECT * INTO r FROM canonical_plan_services WHERE canonical_plan_id=cp AND service_slug='surgery';
  IF r.in_copay <> 40 THEN RAISE EXCEPTION 'A6 FAIL: in_copay=% (want 40)', r.in_copay; END IF;
  IF r.copay IS NOT NULL THEN RAISE EXCEPTION 'A6 FAIL: copay=% (want NULL — legacy frozen, no mirror)', r.copay; END IF;
  IF (r.field_provenance->'in_copay'->>'value') <> '40' THEN RAISE EXCEPTION 'A6 FAIL: in_copay prov value=%', r.field_provenance->'in_copay'->>'value'; END IF;
  IF r.field_provenance ? 'copay' THEN RAISE EXCEPTION 'A6 FAIL: copay prov twin present (want absent — frozen)'; END IF;
  RAISE NOTICE 'A6 PASS — promotion wrote aligned (in_copay 40, prov in_copay) with legacy FROZEN (copay NULL, no prov twin)';
END $$;

-- ── A7: confidence recompute intact (MIN over the aligned provenance key) ──
DO $$
DECLARE cp UUID := gen_random_uuid(); r canonical_plan_services%ROWTYPE;
BEGIN
  PERFORM apply_promotion_event(cp, 'mri', 'in_copay', '25'::jsonb,
    '[{"user_id_hash":"u1","recorded_at":"2026-01-01T00:00:00Z"}]'::jsonb, 'test');
  SELECT * INTO r FROM canonical_plan_services WHERE canonical_plan_id=cp AND service_slug='mri';
  IF r.confidence <> 0.9 THEN RAISE EXCEPTION 'A7 FAIL: confidence=% (want 0.9 — recompute intact)', r.confidence; END IF;
  RAISE NOTICE 'A7 PASS — confidence recompute intact (0.9)';
END $$;

SELECT '>>> CANONICAL-FIELD-ALIGN PHASE-3 FIXTURE: ALL ASSERTIONS PASSED <<<' AS result;
