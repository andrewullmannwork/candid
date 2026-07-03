-- Migration 194: cold-start regen — generalize plan_tier_label + RE-KEY canonical_plan_services to include it,
-- and thread it through apply_promotion_event. (S258, Group B dup-key fix.) The re-key mig 181 deliberately
-- DEFERRED to this lane ("the re-key + ON CONFLICT update land THERE, in lockstep").
--
-- WHY (the dup-key collapse, [[coldstart_regeneration]] §21): the shared resolver maps genuinely-DISTINCT drug
-- cost-share buckets to ONE (slug, place_of_service, component) key — generic Rx Preferred $5 / Non-Preferred
-- $15; Tier 1 / Tier 2; Condition-Care $4 / All-Other $15 — and apply_promotion_event's 4-col ON CONFLICT is
-- last-writer-wins, silently dropping the others. The result is INCORRECT canonical data: a user is served one
-- arbitrary bucket's cost-share. The fix is to make each plan-local cost-share bucket a DISTINCT ROW, keyed by
-- plan_tier_label. plan_tier_label generalizes from "formulary tier_1..12" (mig 181) to "the plan-local drug
-- cost-share bucket" — numeric tier OR named program (condition_care / all_other / preferred / non_preferred /
-- …) — ONE axis (Pattern S / Hard Rule #17: plan-local metadata, never a cross-plan comparison key). The raw
-- verbatim label stays in source_excerpt (§14). A deterministic normalizer (service-resolver derivePlanTierLabel)
-- owns the value vocabulary; this CHECK only validates the SHAPE (lowercase snake token), so an unseen bucket is
-- never silently dropped — while an UN-normalized value (caps/space/empty) fails loudly.
--
-- BACKWARD COMPAT (load-bearing — apply_promotion_event is the LIVE promotion hot-path for ALL uploads + the
-- dispute lane): the new 12th arg p_plan_tier_label DEFAULTs 'none'. Existing 11-arg callers are unchanged and
-- write plan_tier_label='none' — and EVERY existing canonical_plan_services row is already 'none' (mig 181
-- DEFAULT), so the 5-col key is EXACTLY as unique as the old 4-col key for all existing data → ZERO collisions
-- on apply, behavior byte-identical until a caller passes a real bucket. RPC is SHARED with the dispute-grounds
-- lane (workstream_coordination) — its callers pass 11 args → 'none' → unaffected. Prove with a live-shape
-- promotion smoke BEFORE relying on it.
--
-- ⚠ LOCKSTEP (a UNIQUE constraint cannot be flag-gated): the SAME ship updates every cps ON CONFLICT target to
-- the 5-col key — canonical-match.ts:674 (.upsert onConflict) + this RPC. apply_promotion_event's own callers
-- are backward-compatible (default 'none'); canonical-match.ts (deployed) must ship its 5-col onConflict in
-- lockstep with this apply, or a live Pattern-2 upload throws "no unique constraint matching the ON CONFLICT
-- specification". Pre-launch the upload window is controlled.
--
-- ROLLBACK (reversible; pre-launch, all rows 'none'):
--   ALTER TABLE canonical_plan_services DROP CONSTRAINT IF EXISTS uq_canonical_plan_service;
--   ALTER TABLE canonical_plan_services ADD CONSTRAINT uq_canonical_plan_service
--     UNIQUE (canonical_plan_id, service_slug, place_of_service, component);
--   -- then re-apply mig 192 to restore the 11-arg apply_promotion_event (the 12-arg overload is dropped by the
--   -- catalog-drop DO-block on next apply). The widened CHECK is harmless to leave (superset of mig 181's).
--
-- STUDIO NOTE (reference_supabase_studio trap — Studio may report success on a wrapped BEGIN..COMMIT while
-- applying NOTHING): apply via the Supabase CLI for transaction atomicity (the re-key DROP+ADD must be atomic —
-- a partial apply would leave the table with NO unique constraint). If you must use Studio, paste the statements
-- BARE (no BEGIN/COMMIT), in order: (1) the CHECK-widen DO-block + ADD, (2) the uq DROP + ADD, (3) the
-- apply_promotion_event catalog-drop DO-block + CREATE FUNCTION + REVOKE/GRANT. Then run the VERIFY block.

BEGIN;

-- ── 1. Generalize the plan_tier_label CHECK (name-agnostic drop of mig 181's inline CHECK, then widen) ──
DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT conname INTO v_conname FROM pg_constraint
  WHERE conrelid = 'public.canonical_plan_services'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%plan_tier_label%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE canonical_plan_services DROP CONSTRAINT %I', v_conname);
    RAISE NOTICE 'mig 194: dropped prior plan_tier_label CHECK (%).', v_conname;
  END IF;
END $$;

ALTER TABLE canonical_plan_services
  ADD CONSTRAINT canonical_plan_services_plan_tier_label_check
  CHECK (plan_tier_label ~ '^[a-z][a-z0-9_]{0,39}$');

COMMENT ON COLUMN canonical_plan_services.plan_tier_label IS
  'Plan-local drug cost-share BUCKET (Pattern S modifier, Hard Rule #17) — ''none'' (not a bucketed row) or a '
  'normalized lowercase token: a formulary tier (''tier_1''..''tier_12'') OR a named program '
  '(''condition_care''/''all_other''/''preferred''/''non_preferred''/…). Part of uq_canonical_plan_service '
  '(mig 194). Plan-local, NOT cross-plan comparable. Verbatim wording lives in source_excerpt (§14). '
  'Normalizer = src/lib/claims/service-resolver derivePlanTierLabel.';

-- ── 2. RE-KEY uq_canonical_plan_service to include plan_tier_label (mig 181's deferred re-key) ──
ALTER TABLE canonical_plan_services DROP CONSTRAINT IF EXISTS uq_canonical_plan_service;
ALTER TABLE canonical_plan_services
  ADD CONSTRAINT uq_canonical_plan_service
  UNIQUE (canonical_plan_id, service_slug, place_of_service, component, plan_tier_label);

-- ── 3. apply_promotion_event — catalog-drop ALL overloads + CREATE the 12-arg (mig 192 body + p_plan_tier_label
--       threaded into the lock key, the FOR UPDATE lookup, the cps INSERT cols/VALUES, and the 5-col ON CONFLICT.
--       The canonical_plans (plan-identity) branch is UNAFFECTED — plan_tier_label applies only to per-service). ──
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

CREATE FUNCTION public.apply_promotion_event(
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
  p_provenance_meta JSONB DEFAULT NULL,
  p_plan_tier_label TEXT DEFAULT 'none'
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
  v_plan_tier_label TEXT := COALESCE(p_plan_tier_label, 'none');
  v_stored_value JSONB;
  v_meta JSONB;
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

  v_lock_key := hashtextextended(
    'cpe:' || p_canonical_plan_id::TEXT || ':' || COALESCE(p_service_slug, '_')
      || ':' || v_pos || ':' || v_component || ':' || v_plan_tier_label || ':' || p_field_name, 0);
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
      AND place_of_service = v_pos AND component = v_component AND plan_tier_label = v_plan_tier_label
    FOR UPDATE;
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

  -- §14 HOLE 1: a single normalized value feeds BOTH the typed column AND field_provenance.value (no drift).
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

  -- §14 HOLE 2+3: carry the verified excerpt + Pattern-P8 block + resolution_source (whitelisted, null-skipping).
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
    UPDATE canonical_plans SET
      field_provenance = jsonb_set(COALESCE(field_provenance, '{}'::jsonb), ARRAY[p_field_name], v_new_field_entry, true),
      deductible_individual = CASE WHEN p_field_name='in_deductible_individual' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE deductible_individual END,
      deductible_family = CASE WHEN p_field_name='in_deductible_family' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE deductible_family END,
      oop_max_individual = CASE WHEN p_field_name='in_oop_max_individual' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE oop_max_individual END,
      oop_max_family = CASE WHEN p_field_name='in_oop_max_family' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE oop_max_family END,
      -- mig 192: OON plan-identity arms (clobber-guard is caller-side — null identity fields are not promoted;
      -- a non-null verified value authoritatively overwrites on divergence, §19-D).
      out_deductible_individual = CASE WHEN p_field_name='out_deductible_individual' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE out_deductible_individual END,
      out_deductible_family = CASE WHEN p_field_name='out_deductible_family' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE out_deductible_family END,
      out_oop_max_individual = CASE WHEN p_field_name='out_oop_max_individual' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE out_oop_max_individual END,
      out_oop_max_family = CASE WHEN p_field_name='out_oop_max_family' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE out_oop_max_family END,
      plan_name = CASE WHEN p_field_name='plan_name' AND jsonb_typeof(p_corroborated_value)='string' THEN (p_corroborated_value)#>>'{}' ELSE plan_name END,
      plan_year = CASE WHEN p_field_name='plan_year' AND jsonb_typeof(p_corroborated_value)='number' THEN ((p_corroborated_value)::TEXT::NUMERIC)::INT ELSE plan_year END,
      plan_type = CASE WHEN p_field_name='plan_type' AND jsonb_typeof(p_corroborated_value)='string' THEN (p_corroborated_value)#>>'{}' ELSE plan_type END,
      metal_level = CASE WHEN p_field_name='metal_level' AND jsonb_typeof(p_corroborated_value)='string' THEN (p_corroborated_value)#>>'{}' ELSE metal_level END,
      updated_at = now()
    WHERE id = p_canonical_plan_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'apply_promotion_event: canonical_plans row % not found (concurrent DELETE?)', p_canonical_plan_id; END IF;
  ELSE
    INSERT INTO canonical_plan_services (
      canonical_plan_id, service_slug, place_of_service, component, plan_tier_label,
      confidence, source, field_provenance,
      in_copay, in_coinsurance, in_deductible_applies, covered, prior_auth_required, annual_limit,
      out_copay, out_coinsurance, out_deductible_applies, requires_referral, visit_limit, coverage_conditions)
    VALUES (
      p_canonical_plan_id, p_service_slug, v_pos, v_component, v_plan_tier_label,
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
      CASE WHEN p_field_name='visit_limit' AND jsonb_typeof(p_corroborated_value)='number' THEN ((p_corroborated_value)::TEXT::NUMERIC)::INTEGER ELSE NULL END,
      -- mig 192: coverage_conditions arm (TEXT, per-service).
      CASE WHEN p_field_name='coverage_conditions' AND jsonb_typeof(p_corroborated_value)='string' THEN (p_corroborated_value)#>>'{}' ELSE NULL END)
    ON CONFLICT (canonical_plan_id, service_slug, place_of_service, component, plan_tier_label) DO UPDATE SET
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
      coverage_conditions = CASE WHEN p_field_name='coverage_conditions' AND jsonb_typeof(p_corroborated_value)='string' THEN (p_corroborated_value)#>>'{}' ELSE canonical_plan_services.coverage_conditions END,
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

REVOKE ALL ON FUNCTION public.apply_promotion_event(UUID, TEXT, TEXT, JSONB, JSONB, TEXT, UUID, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_promotion_event(UUID, TEXT, TEXT, JSONB, JSONB, TEXT, UUID, TEXT, TEXT, TEXT, JSONB, TEXT) TO service_role;

COMMIT;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────────
-- VERIFY (read-only; run AFTER apply — Studio can falsely report success on a partial run):
--   1) the 5-col unique key (expect column_names incl plan_tier_label, ordinal 5):
-- SELECT a.attname, array_position(c.conkey, a.attnum) AS pos
-- FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
-- WHERE c.conname='uq_canonical_plan_service' ORDER BY pos;
--   2) exactly ONE apply_promotion_event overload, now 12-arg, with the 5-col ON CONFLICT:
-- SELECT pg_get_functiondef('apply_promotion_event(uuid,text,text,jsonb,jsonb,text,uuid,text,text,text,jsonb,text)'::regprocedure)
--   LIKE '%ON CONFLICT (canonical_plan_id, service_slug, place_of_service, component, plan_tier_label)%' AS five_col_onconflict;
-- SELECT count(*) AS overloads FROM pg_proc WHERE proname='apply_promotion_event' AND pronamespace='public'::regnamespace; -- expect 1
--   3) widened CHECK accepts a named bucket, rejects un-normalized:
-- SELECT 'condition_care' ~ '^[a-z][a-z0-9_]{0,39}$' AS accepts_bucket, 'Condition Care' ~ '^[a-z][a-z0-9_]{0,39}$' AS rejects_raw;
--   4) EXECUTE locked to service_role (expect postgres + service_role only):
-- SELECT grantee FROM information_schema.routine_privileges
--   WHERE routine_name='apply_promotion_event' AND privilege_type='EXECUTE' ORDER BY 1;
-- ───────────────────────────────────────────────────────────────────────────────────────────────────────
