-- Migration 187: Coverage-dims seed completion (Group B / S241). ADDITIVE + REVERSIBLE.
-- (Renumbered 186->187 at S242: PR #214 claimed 186_dispute_pin_explicit_override_repair on main.)
--
-- WHY
--   The cold-start regen seeds per-service coverage through the production pipeline
--   (persist plan_covered_services -> expandPerServiceCandidates -> admin_override ->
--   apply_promotion_event). Three gaps blocked a COMPLETE, cite-grade seed:
--     1. plan_covered_services had no requires_referral / visit_limit columns (the
--        coverage_dims_v1 parser now captures both per service). canonical_plan_services
--        ALREADY has both (+ out_*), so only the USER table needs the columns.
--     2. apply_promotion_event promoted only in_*/covered/prior_auth_required/annual_limit
--        -> out_* / requires_referral / visit_limit never reached the typed canonical column
--        (out_* landed in field_provenance but not its column = a partial-write split).
--     3. The promotion provenance entry violated the §14 contract: coinsurance 'value' was
--        stamped RAW while the column was decimal-normalized (value<>column), and it carried
--        NO source_excerpt / Pattern-P8 block / resolution_source -> seed coverage was
--        corroboration-blind AND "referenced, not citable" (fails the A3 cite-grade gate).
--        NOTE: this is a WRITE-PATH fix only. Pre-existing RAW coinsurance provenance values already in
--        canonical (~3% of sampled coins entries carry value>1, e.g. 40 not 0.4 — S213's backfill reports
--        but does not correct them) are normalized by the cold-start regen re-promotion through this fixed
--        RPC + the step-3 §14 normalization backfill (the "0 value<>column" gate), NOT by this migration.
--
-- WHAT
--   1. plan_covered_services: ADD requires_referral BOOLEAN + visit_limit INTEGER (nullable).
--      canonical_plan_services already has requires_referral/visit_limit/out_* -> no canonical ALTER.
--   2. apply_promotion_event: DROP + CREATE (signature gains a trailing p_provenance_meta JSONB
--      DEFAULT NULL) + REVOKE/Re-GRANT to service_role. Per-service arm gains out_copay /
--      out_coinsurance (decimal-normalized) / out_deductible_applies / requires_referral /
--      visit_limit columns. §14 fixes: (a) a single v_stored_value (coinsurance normalized to
--      [0,1]) feeds BOTH the typed column AND field_provenance.<field>.value so they cannot drift;
--      (b) the verified source_excerpt + the full Pattern-P8 5-key block + resolution_source ride
--      in via p_provenance_meta and merge into the provenance entry (whitelisted, null-skipping).
--      The canonical_plans (plan-identity) arm is UNCHANGED (F.0 Phase 5). The annual_limit arm is
--      UNCHANGED — callers pass the numeric annual_limit_value under field_name 'annual_limit'.
--   The 10-arg callers stay valid (named-arg .rpc(); p_provenance_meta defaults NULL = byte-identical
--   provenance to mig 169 EXCEPT the coinsurance value-normalize, which only ever CORRECTS a percent).
--
-- ROLLBACK (reversible): (1) catalog-drop EVERY apply_promotion_event overload (the SAME DO-block used
--   below) so the new 11-arg is removed — re-applying mig 169 alone would NOT drop it and would leave a
--   {10-arg, 11-arg} ambiguity for 10-arg callers; (2) re-create mig 169's 10-arg body; (3) ALTER TABLE
--   plan_covered_services DROP COLUMN visit_limit, DROP COLUMN requires_referral. No data loss (additive;
--   the cold-start regen re-seeds).
--
-- DEPLOY (ORDER MATTERS): apply this migration BEFORE the Group B code deploys. The persist path writes
--   plan_covered_services.requires_referral/visit_limit as STATIC INSERT columns (process-plan.ts ~1302),
--   so deploying that code while the columns are absent breaks every parse/persist. The new RPC arg
--   p_provenance_meta defaults NULL, so applying EARLY is byte-identical for the live 10-arg callers.
--   Net order: apply mig -> then merge/deploy code. NEVER deploy the code first.

BEGIN;

-- ── 1. plan_covered_services: the two parser-captured per-service dims ───────────────────────
ALTER TABLE plan_covered_services
  ADD COLUMN IF NOT EXISTS requires_referral BOOLEAN,
  ADD COLUMN IF NOT EXISTS visit_limit       INTEGER;

COMMENT ON COLUMN plan_covered_services.requires_referral IS
  'coverage_dims_v1 (mig 187): per-service PCP-referral gate (true/false/null=unknown). Parallel to '
  'prior_auth_required; NEVER inferred from prior-auth/admission/visit-limit. Mirrors canonical_plan_services.requires_referral.';
COMMENT ON COLUMN plan_covered_services.visit_limit IS
  'coverage_dims_v1 (mig 187): per-service visit/day COUNT cap (integer). Distinct from the dollar '
  'annual_limit_value. Mirrors canonical_plan_services.visit_limit.';

-- ── 2. apply_promotion_event — DROP + CREATE (new p_provenance_meta arg + new typed-col arms + §14 fixes) ──
-- Drop EVERY existing overload BY CATALOG, not by a guessed signature. History accumulated orphans:
--   mig 068 created the 7-arg (uuid,text,text,jsonb,jsonb,text,uuid) and it was NEVER dropped; mig 111/129
--   added/replaced the 8-arg; mig 148 dropped the 8-arg + created the 10-arg; mig 157/169 replaced the
--   10-arg. So PROD likely holds {7-arg, 10-arg} (+ any Studio-applied phantom). Enumerating signatures
--   would miss the orphan/phantoms and leave an ambiguity landmine — a bare-7-arg-shaped call would match
--   BOTH the stale 7-arg AND the all-defaulted 11-arg below ("could not choose best candidate function"),
--   and the 7-arg body writes pre-alignment legacy columns. A catalog-drop guarantees EXACTLY ONE function
--   after CREATE and makes this migration idempotent on re-apply. (Run the VERIFY step 0 before+after.)
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT oid::regprocedure AS sig
    FROM pg_proc
    WHERE proname = 'apply_promotion_event'
      AND pronamespace = 'public'::regnamespace
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.sig::text;
  END LOOP;
END $$;

CREATE FUNCTION apply_promotion_event(
  p_canonical_plan_id UUID,
  p_service_slug TEXT,
  p_field_name TEXT,
  p_corroborated_value JSONB,
  p_sources JSONB,
  p_fire_source TEXT,
  p_actor_user_id UUID DEFAULT NULL,
  p_force_event_type TEXT DEFAULT NULL,
  p_place_of_service TEXT DEFAULT 'any',
  p_component TEXT DEFAULT 'global',
  p_provenance_meta JSONB DEFAULT NULL   -- NEW (§14): {source_excerpt, source_excerpt_verified,
                                         -- source_excerpt_extraction_method, source_section_hint,
                                         -- source_section_verified, resolution_source}
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_lock_key BIGINT;
  v_existing_provenance JSONB;
  v_existing_field_entry JSONB;
  v_current_confidence NUMERIC;
  v_current_corroborator_count INT;
  v_existing_sources JSONB;
  v_merged_sources JSONB;
  v_new_field_entry JSONB;
  v_event_id UUID;
  v_event_type TEXT;
  v_total_corroborator_count INT;
  v_sources_added INT;
  v_target_table TEXT;
  v_max_k INT;
  v_pos TEXT := COALESCE(p_place_of_service, 'any');
  v_component TEXT := COALESCE(p_component, 'global');
  v_stored_value JSONB;   -- NEW (§14 HOLE 1): value as it lands in the typed column (coinsurance
                          -- normalized); reused for field_provenance.value so column == value.
  v_meta JSONB;           -- NEW (§14 HOLE 2/3): whitelisted provenance metadata to merge.
BEGIN
  IF p_canonical_plan_id IS NULL OR p_field_name IS NULL OR p_corroborated_value IS NULL THEN
    RAISE EXCEPTION 'apply_promotion_event: canonical_plan_id, field_name, corroborated_value are required';
  END IF;
  IF p_force_event_type IS NOT NULL
     AND p_force_event_type NOT IN ('first_promotion', 'corroboration_added', 'value_corrected_via_challenge', 'admin_override') THEN
    RAISE EXCEPTION 'apply_promotion_event: invalid p_force_event_type = %', p_force_event_type;
  END IF;

  v_target_table := CASE WHEN p_service_slug IS NULL THEN 'canonical_plans' ELSE 'canonical_plan_services' END;

  SELECT (config->>'sources_array_max_k')::INT INTO v_max_k
  FROM feature_flag_rules WHERE flag_key = 'canonical_promotion_event_v1';
  v_max_k := COALESCE(v_max_k, 5);

  -- Advisory lock — delimited + pos/component (4-col cell).
  v_lock_key := hashtextextended(
    'cpe:' || p_canonical_plan_id::TEXT || ':' || COALESCE(p_service_slug, '_')
      || ':' || v_pos || ':' || v_component || ':' || p_field_name, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  IF v_target_table = 'canonical_plans' THEN
    SELECT field_provenance INTO v_existing_provenance
    FROM canonical_plans WHERE id = p_canonical_plan_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'apply_promotion_event: canonical_plans row % not found', p_canonical_plan_id;
    END IF;
  ELSE
    SELECT field_provenance INTO v_existing_provenance
    FROM canonical_plan_services
    WHERE canonical_plan_id = p_canonical_plan_id AND service_slug = p_service_slug
      AND place_of_service = v_pos AND component = v_component
    FOR UPDATE;  -- 4-col target; may not exist yet (first promotion -> INSERT below)
  END IF;

  v_existing_field_entry := COALESCE(v_existing_provenance->p_field_name, '{}'::jsonb);
  v_current_confidence := COALESCE((v_existing_field_entry->>'confidence')::NUMERIC, 0);
  v_current_corroborator_count := COALESCE((v_existing_field_entry->>'corroborator_count')::INT, 0);
  v_existing_sources := COALESCE(v_existing_field_entry->'sources', '[]'::jsonb);

  IF p_force_event_type IS NOT NULL THEN
    v_event_type := p_force_event_type;
  ELSIF COALESCE(v_current_confidence, 0) < 0.9 THEN
    v_event_type := 'first_promotion';
  ELSE
    v_event_type := 'corroboration_added';
  END IF;

  WITH all_hashes AS (
    SELECT DISTINCT (entry->>'user_id_hash') AS h
    FROM jsonb_array_elements(v_existing_sources || COALESCE(p_sources, '[]'::jsonb)) AS entries(entry)
  )
  SELECT COUNT(*) INTO v_total_corroborator_count FROM all_hashes;

  WITH unioned AS (
    SELECT DISTINCT ON (entry->>'user_id_hash') entry
    FROM jsonb_array_elements(v_existing_sources || COALESCE(p_sources, '[]'::jsonb)) AS entries(entry)
    ORDER BY entry->>'user_id_hash', (entry->>'recorded_at')::TIMESTAMPTZ NULLS LAST
  ),
  ordered AS (
    SELECT entry FROM unioned ORDER BY (entry->>'recorded_at')::TIMESTAMPTZ NULLS LAST LIMIT v_max_k
  )
  SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb) INTO v_merged_sources FROM ordered;

  v_sources_added := jsonb_array_length(v_merged_sources) - jsonb_array_length(v_existing_sources);
  IF v_sources_added < 0 THEN v_sources_added := 0; END IF;

  -- §14 HOLE 1: the value as it lands in the typed column (coinsurance normalized to [0,1]); used for
  -- BOTH the column write below AND field_provenance.<field>.value, so they can never diverge.
  v_stored_value := CASE
    WHEN p_field_name IN ('in_coinsurance', 'out_coinsurance') AND jsonb_typeof(p_corroborated_value) = 'number'
      THEN to_jsonb( LEAST(1.0::NUMERIC, GREATEST(0.0::NUMERIC,
             CASE WHEN ((p_corroborated_value)::TEXT::NUMERIC) > 1 THEN ((p_corroborated_value)::TEXT::NUMERIC) / 100
                  ELSE (p_corroborated_value)::TEXT::NUMERIC END)) )
    ELSE p_corroborated_value
  END;

  v_new_field_entry := jsonb_build_object(
    'value', v_stored_value, 'confidence', 0.9,
    'source', CASE WHEN v_event_type = 'admin_override' THEN 'admin_attested'
                   WHEN v_event_type = 'value_corrected_via_challenge' THEN 'challenge_resolution'
                   ELSE 'multi_source_corroboration' END,
    'corroborator_count', v_total_corroborator_count, 'sources', v_merged_sources, 'promoted_at', now());

  -- §14 HOLE 2+3: carry the verified excerpt + the full Pattern-P8 5-key block + resolution_source
  -- (cite-grade gate inputs) when the caller supplies them. Whitelisted + null-skipping so a partial
  -- meta never clobbers the entry with nulls. The trailing default (NULL) keeps 10-arg callers byte-identical.
  IF p_provenance_meta IS NOT NULL AND jsonb_typeof(p_provenance_meta) = 'object' THEN
    SELECT COALESCE(jsonb_object_agg(k, val), '{}'::jsonb) INTO v_meta
    FROM jsonb_each(p_provenance_meta) AS m(k, val)
    WHERE k IN ('source_excerpt', 'source_excerpt_verified', 'source_excerpt_extraction_method',
                'source_section_hint', 'source_section_verified', 'resolution_source')
      AND val IS NOT NULL AND val <> 'null'::jsonb;
    IF v_meta IS NOT NULL AND v_meta <> '{}'::jsonb THEN
      v_new_field_entry := v_new_field_entry || v_meta;
    END IF;
  END IF;

  v_event_id := gen_random_uuid();

  IF v_target_table = 'canonical_plans' THEN
    -- UNCHANGED from mig 169 (plan-identity typed-col sync; canonical_plans is F.0 Phase 5).
    UPDATE canonical_plans SET
      field_provenance = jsonb_set(COALESCE(field_provenance, '{}'::jsonb), ARRAY[p_field_name], v_new_field_entry, true),
      deductible_individual = CASE WHEN p_field_name='in_deductible_individual' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE deductible_individual END,
      deductible_family = CASE WHEN p_field_name='in_deductible_family' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE deductible_family END,
      oop_max_individual = CASE WHEN p_field_name='in_oop_max_individual' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE oop_max_individual END,
      oop_max_family = CASE WHEN p_field_name='in_oop_max_family' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE oop_max_family END,
      plan_name = CASE WHEN p_field_name='plan_name' AND jsonb_typeof(p_corroborated_value)='string' THEN (p_corroborated_value)#>>'{}' ELSE plan_name END,
      plan_year = CASE WHEN p_field_name='plan_year' AND jsonb_typeof(p_corroborated_value)='number' THEN ((p_corroborated_value)::TEXT::NUMERIC)::INT ELSE plan_year END,
      plan_type = CASE WHEN p_field_name='plan_type' AND jsonb_typeof(p_corroborated_value)='string' THEN (p_corroborated_value)#>>'{}' ELSE plan_type END,
      metal_level = CASE WHEN p_field_name='metal_level' AND jsonb_typeof(p_corroborated_value)='string' THEN (p_corroborated_value)#>>'{}' ELSE metal_level END,
      updated_at = now()
    WHERE id = p_canonical_plan_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'apply_promotion_event: canonical_plans row % not found (concurrent DELETE?)', p_canonical_plan_id; END IF;
  ELSE
    -- canonical_plan_services arm. Aligned cols (mig 169) + NEW out_*/requires_referral/visit_limit.
    -- in_/out_coinsurance columns use v_stored_value (== field_provenance.value) so they cannot drift.
    INSERT INTO canonical_plan_services (
      canonical_plan_id, service_slug, place_of_service, component,
      confidence, source, field_provenance,
      in_copay, in_coinsurance, in_deductible_applies, covered, prior_auth_required, annual_limit,
      out_copay, out_coinsurance, out_deductible_applies, requires_referral, visit_limit)
    VALUES (
      p_canonical_plan_id, p_service_slug, v_pos, v_component,
      0.9, CASE WHEN v_event_type='admin_override' THEN 'admin_attested' ELSE 'multi_source_corroboration' END,
      jsonb_build_object(p_field_name, v_new_field_entry),
      CASE WHEN p_field_name='in_copay' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE NULL END,
      CASE WHEN p_field_name='in_coinsurance' AND jsonb_typeof(p_corroborated_value)='number' THEN (v_stored_value)::TEXT::NUMERIC ELSE NULL END,
      CASE WHEN p_field_name='in_deductible_applies' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE NULL END,
      CASE WHEN p_field_name='covered' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE NULL END,
      CASE WHEN p_field_name='prior_auth_required' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE NULL END,
      CASE WHEN p_field_name='annual_limit' AND jsonb_typeof(p_corroborated_value)='number' THEN ((p_corroborated_value)::TEXT::NUMERIC)::INTEGER ELSE NULL END,
      CASE WHEN p_field_name='out_copay' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE NULL END,
      CASE WHEN p_field_name='out_coinsurance' AND jsonb_typeof(p_corroborated_value)='number' THEN (v_stored_value)::TEXT::NUMERIC ELSE NULL END,
      CASE WHEN p_field_name='out_deductible_applies' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE NULL END,
      CASE WHEN p_field_name='requires_referral' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE NULL END,
      CASE WHEN p_field_name='visit_limit' AND jsonb_typeof(p_corroborated_value)='number' THEN ((p_corroborated_value)::TEXT::NUMERIC)::INTEGER ELSE NULL END)
    ON CONFLICT (canonical_plan_id, service_slug, place_of_service, component) DO UPDATE SET
      field_provenance = jsonb_set(COALESCE(canonical_plan_services.field_provenance, '{}'::jsonb), ARRAY[p_field_name], v_new_field_entry, true),
      confidence = GREATEST(canonical_plan_services.confidence, 0.9),
      source = CASE WHEN v_event_type='admin_override' THEN 'admin_attested' ELSE 'multi_source_corroboration' END,
      in_copay = CASE WHEN p_field_name='in_copay' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE canonical_plan_services.in_copay END,
      in_coinsurance = CASE WHEN p_field_name='in_coinsurance' AND jsonb_typeof(p_corroborated_value)='number' THEN (v_stored_value)::TEXT::NUMERIC ELSE canonical_plan_services.in_coinsurance END,
      in_deductible_applies = CASE WHEN p_field_name='in_deductible_applies' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE canonical_plan_services.in_deductible_applies END,
      covered = CASE WHEN p_field_name='covered' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE canonical_plan_services.covered END,
      prior_auth_required = CASE WHEN p_field_name='prior_auth_required' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE canonical_plan_services.prior_auth_required END,
      annual_limit = CASE WHEN p_field_name='annual_limit' AND jsonb_typeof(p_corroborated_value)='number' THEN ((p_corroborated_value)::TEXT::NUMERIC)::INTEGER ELSE canonical_plan_services.annual_limit END,
      out_copay = CASE WHEN p_field_name='out_copay' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE canonical_plan_services.out_copay END,
      out_coinsurance = CASE WHEN p_field_name='out_coinsurance' AND jsonb_typeof(p_corroborated_value)='number' THEN (v_stored_value)::TEXT::NUMERIC ELSE canonical_plan_services.out_coinsurance END,
      out_deductible_applies = CASE WHEN p_field_name='out_deductible_applies' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE canonical_plan_services.out_deductible_applies END,
      requires_referral = CASE WHEN p_field_name='requires_referral' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE canonical_plan_services.requires_referral END,
      visit_limit = CASE WHEN p_field_name='visit_limit' AND jsonb_typeof(p_corroborated_value)='number' THEN ((p_corroborated_value)::TEXT::NUMERIC)::INTEGER ELSE canonical_plan_services.visit_limit END,
      updated_at = now();
  END IF;

  INSERT INTO canonical_promotion_events (
    id, canonical_plan_id, service_slug, place_of_service, component, field_name,
    event_type, fire_source, corroborator_count, sources_count, corroborated_value, actor_user_id, fired_at)
  VALUES (
    v_event_id, p_canonical_plan_id, p_service_slug,
    CASE WHEN p_service_slug IS NULL THEN NULL ELSE v_pos END,
    CASE WHEN p_service_slug IS NULL THEN NULL ELSE v_component END,
    p_field_name, v_event_type, p_fire_source, v_total_corroborator_count, v_sources_added,
    p_corroborated_value, p_actor_user_id, now());

  RETURN v_event_id;
END;
$$;

-- Supabase ALTER DEFAULT PRIVILEGES auto-grants EXECUTE on EVERY new public function to anon +
-- authenticated DIRECTLY (not via PUBLIC), so the DROP+CREATE above re-grants them. REVOKE FROM PUBLIC
-- ALONE IS INSUFFICIENT — the direct anon/authenticated grants must be revoked too to restore the
-- Pattern 1 #14 function-grant defense (service_role-only; mig 068 intent). postgres (owner) keeps EXECUTE.
REVOKE ALL ON FUNCTION apply_promotion_event(UUID, TEXT, TEXT, JSONB, JSONB, TEXT, UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_promotion_event(UUID, TEXT, TEXT, JSONB, JSONB, TEXT, UUID, TEXT, TEXT, TEXT, JSONB) TO service_role;

COMMENT ON FUNCTION apply_promotion_event(UUID, TEXT, TEXT, JSONB, JSONB, TEXT, UUID, TEXT, TEXT, TEXT, JSONB) IS
  'Group B (mig 187): canonical promotion writer, cell-aware (4-col). Per-service arm writes the ALIGNED '
  'in_*/covered/prior_auth_required/annual_limit + NEW out_*/requires_referral/visit_limit columns keyed by '
  'p_field_name. §14: a single v_stored_value (coinsurance normalized to [0,1]) feeds BOTH the column and '
  'field_provenance.value; p_provenance_meta carries the verified source_excerpt + Pattern-P8 5-key block + '
  'resolution_source for the A3 cite-grade gate. canonical_plans (plan-identity) arm UNCHANGED (F.0 Phase 5). '
  'Reproduced from mig 169 + additions; 10-arg callers stay valid (p_provenance_meta defaults NULL).';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- VERIFY (read-only; Supabase Studio can falsely report success on a partial run):
--   0) OVERLOAD SET — run BEFORE apply (may show the stale 7-arg + the active 10-arg) AND AFTER apply
--      (MUST be EXACTLY ONE row = the 11-arg ...,text,text,text,jsonb). This proves the catalog-drop
--      collapsed every prior overload and left no ambiguity landmine:
-- SELECT oid::regprocedure FROM pg_proc
--   WHERE proname='apply_promotion_event' AND pronamespace='public'::regnamespace ORDER BY 1;
--   1) new user-table columns present (expect requires_referral=boolean, visit_limit=integer):
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name='plan_covered_services' AND column_name IN ('requires_referral','visit_limit') ORDER BY column_name;
--   2) new arg present (expect t):
-- SELECT pg_get_function_identity_arguments('apply_promotion_event'::regproc) LIKE '%p_provenance_meta jsonb%' AS has_meta_arg;
--   3) new arms present (expect t,t,t):
-- SELECT pg_get_functiondef('apply_promotion_event(uuid,text,text,jsonb,jsonb,text,uuid,text,text,text,jsonb)'::regprocedure) LIKE '%requires_referral = CASE WHEN p_field_name=''requires_referral''%' AS referral_arm,
--        pg_get_functiondef('apply_promotion_event(uuid,text,text,jsonb,jsonb,text,uuid,text,text,text,jsonb)'::regprocedure) LIKE '%out_coinsurance = CASE WHEN p_field_name=''out_coinsurance''%' AS out_coins_arm,
--        pg_get_functiondef('apply_promotion_event(uuid,text,text,jsonb,jsonb,text,uuid,text,text,text,jsonb)'::regprocedure) LIKE '%visit_limit = CASE WHEN p_field_name=''visit_limit''%' AS visit_arm;
--   4) grant locked down (expect ONLY postgres + service_role — anon/authenticated MUST be ABSENT):
-- SELECT grantee FROM information_schema.routine_privileges
--   WHERE routine_name='apply_promotion_event' AND privilege_type='EXECUTE' ORDER BY grantee;
-- ─────────────────────────────────────────────────────────────────────────────────────────────
