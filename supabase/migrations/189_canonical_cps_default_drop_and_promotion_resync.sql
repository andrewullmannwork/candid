-- Migration 189: canonical_plan_services cite-grade honesty fix (S245) — drop the lingering aligned-boolean
-- column DEFAULTs + resync apply_promotion_event to the committed mig-187 body. ADDITIVE-SAFE · idempotent · reversible.
--
-- ROOT CAUSE (caught by scripts/path-b-pr1-fixture.ts): on PROD a first-promotion INSERT leaves
-- canonical_plan_services.in_deductible_applies / covered / prior_auth_required at their F.0 column DEFAULTs
-- (true / true / false) instead of honest NULL. TWO drifts vs committed source:
--   (A) SCHEMA: mig 169 intended to DROP these defaults (its "ALTER COLUMN ... DROP DEFAULT") but it never
--       took effect on PROD (the columns still carry the F.0 defaults).
--   (B) FUNCTION: the applied apply_promotion_event INSERT does not explicitly set these 3 columns (lets the
--       default fire), drifting from the committed mig-169/187 INSERT (which lists them with CASE ... ELSE NULL).
-- Net: a canonical row can silently assert "covered / deductible-applies / no-prior-auth" with NO evidence —
-- a cite-grade-honesty violation. (The fixture's Tests 7-8 confirm the 11-arg mig-187 function IS live, so this
-- is an in-function INSERT drift, not a wrong-overload issue.)
--
-- FIX (both halves; no bandaid):
--   1. DROP DEFAULT on the 3 aligned booleans (re-applies mig 169's intent). After this, EVERY writer that
--      omits these columns gets NULL (honest unknown), not an assumption.
--   2. Catalog-drop EVERY apply_promotion_event overload + CREATE the committed 11-arg function (logic
--      byte-identical to mig 187) so PROD == committed source: the INSERT explicitly sets all aligned columns
--      (un-promoted -> explicit NULL regardless of any default), and every other behavior (out_*/referral/
--      visit/annual arms, the single v_stored_value coinsurance normalize feeding column == provenance.value,
--      the p_provenance_meta Pattern-P8 carry) is the committed behavior. Idempotent -> exactly one function.
--
-- WHY BOTH: #2 makes the promotion writer honest immediately (explicit NULL overrides any default) and restores
-- the function to the committed source; #1 removes the latent trap for EVERY other writer (seed builder / merge /
-- persist) that omits these columns.
--
-- DATA NOTE: existing rows already storing default-assumed true/true/false are NOT rewritten here (true-from-
-- evidence vs true-from-default are indistinguishable post-hoc) — the cold-start REGEN re-derives them from
-- source + the §14 probe measures the current distribution. This migration fixes go-forward writes only.
--
-- ROLLBACK (reversible): (1) re-ADD the defaults (aligned + legacy):
--   ALTER TABLE public.canonical_plan_services
--     ALTER COLUMN in_deductible_applies SET DEFAULT true,  ALTER COLUMN covered             SET DEFAULT true,
--     ALTER COLUMN prior_auth_required   SET DEFAULT false, ALTER COLUMN deductible_applies  SET DEFAULT true,
--     ALTER COLUMN is_covered            SET DEFAULT true,  ALTER COLUMN requires_prior_auth SET DEFAULT false;
--   (2) the function body equals mig 187 -> no function rollback needed (re-applying mig 187 is a no-op).
--
-- DEPLOY: standalone; apply any time after mig 187. No code change required (the committed code already calls
--   the 11-arg function; the regen promotes every captured field). Supersedes the partial 169/187 application
--   for these objects.
-- STUDIO NOTE (S245, learned the hard way): the Supabase SQL editor did NOT persist this file pasted as one
--   wrapped BEGIN..COMMIT block (reported success, applied nothing — the reference_supabase_studio trap).
--   Apply via the CLI, OR paste the statements BARE (no BEGIN/COMMIT): (1) the multi-column ALTER, then
--   (2) the DO-block + CREATE FUNCTION + REVOKE/GRANT. Verify each with the read-only checks below.

BEGIN;

-- ── 1. Drop the lingering DEFAULTs on BOTH the aligned AND the legacy booleans (idempotent) ──
-- ROOT CAUSE (deeper than first thought): the mig-173 align_mirror_cps_row() trigger backfills aligned
-- FROM legacy on a NULL-aligned INSERT (IF NEW.in_deductible_applies IS NULL THEN := NEW.deductible_applies,
-- + covered<-is_covered, prior_auth_required<-requires_prior_auth). The LEGACY booleans still carry
-- DEFAULT true/true/false, so a partial INSERT (function writes aligned NULL) has the net copy the legacy
-- DEFAULT into the aligned column -> assumed true. Dropping ONLY the aligned defaults is defeated by the net.
-- Drop BOTH sets so an un-promoted boolean is honest NULL end-to-end. (Legacy cols are FROZEN/zero-reader
-- per mig 173; their full DROP is the separate planned Phase 4 / mig 174.)
ALTER TABLE public.canonical_plan_services
  ALTER COLUMN in_deductible_applies DROP DEFAULT,
  ALTER COLUMN covered               DROP DEFAULT,
  ALTER COLUMN prior_auth_required   DROP DEFAULT,
  ALTER COLUMN deductible_applies    DROP DEFAULT,
  ALTER COLUMN is_covered            DROP DEFAULT,
  ALTER COLUMN requires_prior_auth   DROP DEFAULT;

-- ── 2. Resync apply_promotion_event to the committed mig-187 body (catalog-drop ALL overloads + CREATE) ──
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
  p_provenance_meta JSONB DEFAULT NULL
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
      plan_name = CASE WHEN p_field_name='plan_name' AND jsonb_typeof(p_corroborated_value)='string' THEN (p_corroborated_value)#>>'{}' ELSE plan_name END,
      plan_year = CASE WHEN p_field_name='plan_year' AND jsonb_typeof(p_corroborated_value)='number' THEN ((p_corroborated_value)::TEXT::NUMERIC)::INT ELSE plan_year END,
      plan_type = CASE WHEN p_field_name='plan_type' AND jsonb_typeof(p_corroborated_value)='string' THEN (p_corroborated_value)#>>'{}' ELSE plan_type END,
      metal_level = CASE WHEN p_field_name='metal_level' AND jsonb_typeof(p_corroborated_value)='string' THEN (p_corroborated_value)#>>'{}' ELSE metal_level END,
      updated_at = now()
    WHERE id = p_canonical_plan_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'apply_promotion_event: canonical_plans row % not found (concurrent DELETE?)', p_canonical_plan_id; END IF;
  ELSE
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

REVOKE ALL ON FUNCTION public.apply_promotion_event(UUID, TEXT, TEXT, JSONB, JSONB, TEXT, UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_promotion_event(UUID, TEXT, TEXT, JSONB, JSONB, TEXT, UUID, TEXT, TEXT, TEXT, JSONB) TO service_role;

COMMIT;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────────
-- VERIFY (read-only; run AFTER apply — Supabase Studio can falsely report success on a partial run):
--   1) defaults gone (expect column_default = NULL for all SIX aligned + legacy booleans):
-- SELECT column_name, column_default FROM information_schema.columns
--   WHERE table_name='canonical_plan_services'
--     AND column_name IN ('in_deductible_applies','covered','prior_auth_required','deductible_applies','is_covered','requires_prior_auth') ORDER BY column_name;
--   2) exactly one function overload (expect ONE row = the 11-arg ...,text,text,text,jsonb):
-- SELECT oid::regprocedure FROM pg_proc
--   WHERE proname='apply_promotion_event' AND pronamespace='public'::regnamespace ORDER BY 1;
--   3) INSERT arm explicitly sets the 3 booleans (expect t,t,t):
-- SELECT pg_get_functiondef('apply_promotion_event(uuid,text,text,jsonb,jsonb,text,uuid,text,text,text,jsonb)'::regprocedure) LIKE '%in_deductible_applies, covered, prior_auth_required%' AS insert_lists_booleans,
--        pg_get_functiondef('apply_promotion_event(uuid,text,text,jsonb,jsonb,text,uuid,text,text,text,jsonb)'::regprocedure) LIKE '%out_coinsurance = CASE WHEN p_field_name=''out_coinsurance''%' AS out_coins_arm,
--        pg_get_functiondef('apply_promotion_event(uuid,text,text,jsonb,jsonb,text,uuid,text,text,text,jsonb)'::regprocedure) LIKE '%requires_referral = CASE WHEN p_field_name=''requires_referral''%' AS referral_arm;
--   4) grant locked down (expect ONLY postgres + service_role — anon/authenticated MUST be ABSENT):
-- SELECT grantee FROM information_schema.routine_privileges
--   WHERE routine_name='apply_promotion_event' AND privilege_type='EXECUTE' ORDER BY grantee;
-- ───────────────────────────────────────────────────────────────────────────────────────────────────────
