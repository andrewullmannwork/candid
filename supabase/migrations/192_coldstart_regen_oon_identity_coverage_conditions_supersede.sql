-- Migration 192: cold-start regen write path — canonical OON plan-identity + coverage_conditions promotion +
-- controlled supersede + seeded_via tag (S256, Group B). ADDITIVE-SAFE · idempotent · reversible.
--
-- WHY (cold-start regen, [[coldstart_regeneration]] §18/§19 + §16-D): the regen re-parses the ~1,300-plan SBC
-- seed through the production pipeline via Sonnet sub-agents and promotes the result to canonical. To capture
-- ALL the data the SBC states (Andrew S256: "we're doing the hard work of the parse, get all the data"), three
-- gaps in the shipped promotion path must close:
--   1. canonical_plans has NO out-of-network plan-identity columns (insurance_plans already has out_deductible_*
--      / out_oop_max_*; canonical does not) — so a selected seed plan can't surface the OON deductible/OOP a
--      PPO/POS claim needs. ADD the 4 columns + promote them (extractImportantQuestions already emits them,
--      cite-grade, in + out — src/lib/sbc/haiku-prompts/important-questions.ts).
--   2. coverage_conditions is written to plan_covered_services but never promoted to canonical (absent column +
--      no RPC arm) though /api/plan/analyze:370 → /plan reads it (§19-F). ADD the column + arm.
--   3. re-resolved slugs orphan: the shipped promotion upserts by (plan,slug,pos,component) and NEVER deletes
--      (mig 169/187/189), so a slug the new parse no longer produces leaves a permanent stale canonical row.
--      ADD a surgical, gated regen_supersede_services() (Rule #10 controlled removal; snapshot is the recovery
--      net, the run ledger records superseded keys).
-- + seeded_via tag so regenerated rows are identifiable (harness stamps it post-promotion; not an RPC param).
--
-- BACKWARD COMPAT (load-bearing — apply_promotion_event is the LIVE promotion hot-path for ALL uploads + the
-- dispute lane): the DROP+CREATE keeps the EXACT 11-arg signature of mig 189. The only body changes are
-- ADDITIVE CASE arms keyed on NEW p_field_name values ('out_deductible_individual' / 'out_deductible_family' /
-- 'out_oop_max_individual' / 'out_oop_max_family' / 'coverage_conditions'). For every existing caller (which
-- passes none of those field names) the new arms fall to ELSE <existing column> → behavior is byte-identical.
-- Prove with a live-shape promotion smoke + the dispute-lane call BEFORE apply (S256 finding #4). RPC is SHARED
-- with the dispute-grounds lane → noted in workstream_coordination; flag the reviewer.
--
-- ROLLBACK (reversible):
--   1. function: re-applying mig 189 restores the prior apply_promotion_event body (the new arms are gone; the
--      added columns simply stop being written). DROP FUNCTION regen_supersede_services(uuid,jsonb).
--   2. columns (only if fully unwinding — they are nullable + unread until the regen runs):
--      ALTER TABLE canonical_plans DROP COLUMN out_deductible_individual, DROP COLUMN out_deductible_family,
--        DROP COLUMN out_oop_max_individual, DROP COLUMN out_oop_max_family, DROP COLUMN seeded_via;
--      ALTER TABLE canonical_plan_services DROP COLUMN coverage_conditions, DROP COLUMN seeded_via;
--   3. data superseded by regen_supersede_services is restorable from the per-canonical snapshot JSON
--      (.scratch-regen/seed-snapshot-rollback.ts) taken before each write.
--
-- STUDIO NOTE (S245/S256, the reference_supabase_studio trap): the Supabase SQL editor may report success on a
-- wrapped BEGIN..COMMIT block while applying NOTHING. Apply via the CLI, OR paste the statements BARE (no
-- BEGIN/COMMIT): (1) the two ALTER TABLEs, then (2) the DO-block + CREATE FUNCTION apply_promotion_event +
-- its REVOKE/GRANT, then (3) CREATE FUNCTION regen_supersede_services + its REVOKE/GRANT. Verify each with the
-- read-only checks at the bottom.

BEGIN;

-- ── 1. Additive columns (idempotent) ──
ALTER TABLE public.canonical_plans
  ADD COLUMN IF NOT EXISTS out_deductible_individual NUMERIC,
  ADD COLUMN IF NOT EXISTS out_deductible_family     NUMERIC,
  ADD COLUMN IF NOT EXISTS out_oop_max_individual    NUMERIC,
  ADD COLUMN IF NOT EXISTS out_oop_max_family        NUMERIC,
  ADD COLUMN IF NOT EXISTS seeded_via                TEXT;

ALTER TABLE public.canonical_plan_services
  ADD COLUMN IF NOT EXISTS coverage_conditions TEXT,
  ADD COLUMN IF NOT EXISTS seeded_via          TEXT;

-- ── 2. apply_promotion_event — resync to the committed mig-189 body + ADD the OON-identity + coverage_conditions
--       arms (catalog-drop ALL overloads + CREATE the single 11-arg function). Same signature as mig 189. ──
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
      canonical_plan_id, service_slug, place_of_service, component,
      confidence, source, field_provenance,
      in_copay, in_coinsurance, in_deductible_applies, covered, prior_auth_required, annual_limit,
      out_copay, out_coinsurance, out_deductible_applies, requires_referral, visit_limit, coverage_conditions)
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
      CASE WHEN p_field_name='visit_limit' AND jsonb_typeof(p_corroborated_value)='number' THEN ((p_corroborated_value)::TEXT::NUMERIC)::INTEGER ELSE NULL END,
      -- mig 192: coverage_conditions arm (TEXT, per-service).
      CASE WHEN p_field_name='coverage_conditions' AND jsonb_typeof(p_corroborated_value)='string' THEN (p_corroborated_value)#>>'{}' ELSE NULL END)
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

REVOKE ALL ON FUNCTION public.apply_promotion_event(UUID, TEXT, TEXT, JSONB, JSONB, TEXT, UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_promotion_event(UUID, TEXT, TEXT, JSONB, JSONB, TEXT, UUID, TEXT, TEXT, TEXT, JSONB) TO service_role;

-- ── 3. regen_supersede_services — surgical, gated removal of canonical_plan_services rows the new parse no
--       longer produces (Rule #10 controlled supersede). Deletes only rows for THIS canonical whose
--       (service_slug, place_of_service, component) is NOT in the kept set; RETURNS the deleted keys so the
--       cold-start harness logs them to the run ledger. The per-canonical snapshot JSON is the recovery net.
--       No canonical_promotion_events write (its event_type CHECK is for field promotions, not row removals;
--       keeping supersede out of that stream avoids touching the shared constrained audit table). ──
CREATE FUNCTION public.regen_supersede_services(
  p_canonical_plan_id UUID,
  p_keep_keys JSONB   -- array of {service_slug, place_of_service, component}; pos/component default any/global
)
RETURNS TABLE (deleted_service_slug TEXT, deleted_place_of_service TEXT, deleted_component TEXT)
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_canonical_plan_id IS NULL OR p_keep_keys IS NULL OR jsonb_typeof(p_keep_keys) <> 'array' THEN
    RAISE EXCEPTION 'regen_supersede_services: p_canonical_plan_id + p_keep_keys(array) are required';
  END IF;

  RETURN QUERY
  WITH keep AS (
    SELECT (k->>'service_slug') AS slug,
           COALESCE(k->>'place_of_service', 'any') AS pos,
           COALESCE(k->>'component', 'global') AS comp
    FROM jsonb_array_elements(p_keep_keys) AS k
  ),
  del AS (
    DELETE FROM canonical_plan_services c
    WHERE c.canonical_plan_id = p_canonical_plan_id
      AND NOT EXISTS (
        SELECT 1 FROM keep
        WHERE keep.slug = c.service_slug
          AND keep.pos  = c.place_of_service
          AND keep.comp = c.component
      )
    RETURNING c.service_slug, c.place_of_service, c.component
  )
  SELECT del.service_slug, del.place_of_service, del.component FROM del;
END;
$$;

REVOKE ALL ON FUNCTION public.regen_supersede_services(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.regen_supersede_services(UUID, JSONB) TO service_role;

COMMIT;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────────
-- VERIFY (read-only; run AFTER apply — Supabase Studio can falsely report success on a partial run):
--   1) OON identity + tag columns exist (expect 5 rows):
-- SELECT column_name FROM information_schema.columns WHERE table_name='canonical_plans'
--   AND column_name IN ('out_deductible_individual','out_deductible_family','out_oop_max_individual','out_oop_max_family','seeded_via') ORDER BY 1;
--   2) cps coverage_conditions + tag (expect 2 rows):
-- SELECT column_name FROM information_schema.columns WHERE table_name='canonical_plan_services'
--   AND column_name IN ('coverage_conditions','seeded_via') ORDER BY 1;
--   3) exactly ONE apply_promotion_event overload (the 11-arg) + the new arms present:
-- SELECT pg_get_functiondef('apply_promotion_event(uuid,text,text,jsonb,jsonb,text,uuid,text,text,text,jsonb)'::regprocedure) LIKE '%out_oop_max_family = CASE WHEN p_field_name=''out_oop_max_family''%' AS oon_identity_arm,
--        pg_get_functiondef('apply_promotion_event(uuid,text,text,jsonb,jsonb,text,uuid,text,text,text,jsonb)'::regprocedure) LIKE '%coverage_conditions = CASE WHEN p_field_name=''coverage_conditions''%' AS coverage_conditions_arm;
--   4) supersede function exists + locked to service_role (expect ONLY postgres + service_role):
-- SELECT routine_name, grantee FROM information_schema.routine_privileges
--   WHERE routine_name IN ('apply_promotion_event','regen_supersede_services') AND privilege_type='EXECUTE' ORDER BY 1,2;
-- ───────────────────────────────────────────────────────────────────────────────────────────────────────
