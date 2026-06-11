-- =============================================================================
-- MIGRATION 157 — Service Thesaurus Phase 1a: plan_covered_services 3→4-col re-key
--                 (+ benefit_corrections cell-capture columns)
-- =============================================================================
-- SoT: plans/service_thesaurus_phase1a.md §9.8 (Step C handoff) · §3.2.
-- Grounded against PROD `214de60` (S176). Tracker: pre_launch_backend_hardening §3 Thesaurus.
--
-- APPLY-SAFETY: BREAKING (PART A) — ships + applies IN LOCKSTEP with the T4 write-path code.
--   mig 156 (additive) was apply-early-safe; this one is NOT. The plan_covered_services UNIQUE
--   goes 3-col → 4-col, which breaks every existing 3-col `onConflict` upsert until the code
--   targets the 4-col key. Pre-launch (no PROD users) every plan_covered_services row carries
--   component='global' (mig 156 DEFAULT), so the 4-col key is EXACTLY as unique as the old 3-col
--   for the all-global state → ZERO collisions on apply, byte-identical row outcomes flag-OFF.
--   The brief code↔mig deploy window is accepted (Andrew, §9.8 refinement 4: single breaking mig).
--
-- WHAT CHANGES:
--   PART A — plan_covered_services: discover + drop the mig-009 INLINE (auto-named) 3-col UNIQUE
--            (insurance_plan_id, service_id, place_of_service) by its COLUMN SIGNATURE (name-
--            agnostic — mig 009 created it unnamed inside CREATE TABLE), then add the named 4-col
--            uq_plan_covered_service (… , component). Mirrors mig 147's canonical re-key intent,
--            adapted for the unnamed source constraint.
--   PART B — benefit_corrections: additive place_of_service + component (nullable) so a benefit
--            correction can target the SPECIFIC cost-share cell the user was viewing (the cell
--            coordinates are dropped today → the apply can't know which facility/professional row
--            to fix). Forward-capture: populated once the /plan submit payload carries them
--            (Backend→Frontend request); the apply degrades gracefully meanwhile (single-cell auto,
--            multi-cell reject — never a silent over-write).
--   PART C — apply_promotion_event: add the annual_limit typed-col arm (INSERT + ON CONFLICT UPDATE)
--            so the benefit-correction apply path routes ALL structured fields through the one
--            canonical write authority (typed col + field_provenance synced, S135 Path B). Signature
--            unchanged -> CREATE OR REPLACE (grants preserved); behavior-preserving + additive arm only.
--
-- WHY component on plan_covered_services already exists: mig 156 PART A added it (PROD-applied).
--   This migration only re-keys the UNIQUE to INCLUDE it (canonical_plan_services was already
--   re-keyed to the 4-col uq_canonical_plan_service by mig 147 — this brings the user-side table
--   to parity).
--
-- ROLLBACK (run AFTER the T4 code reverts to 3-col onConflict):
--   ALTER TABLE benefit_corrections DROP COLUMN IF EXISTS component, DROP COLUMN IF EXISTS place_of_service;
--   ALTER TABLE plan_covered_services DROP CONSTRAINT IF EXISTS uq_plan_covered_service;
--   ALTER TABLE plan_covered_services
--     ADD CONSTRAINT plan_covered_services_insurance_plan_id_service_id_place_of_s_key
--     UNIQUE (insurance_plan_id, service_id, place_of_service);
--   -- (the restored 3-col unique is safe pre-launch: all rows are component='global' → no dup.)
--   PART C: re-run mig 148's apply_promotion_event CREATE OR REPLACE (restores the pre-annual_limit body).
--
-- FIXTURE: scripts/calibration/fixtures/thesaurus-phase1a/run-157.sh (ephemeral PG):
--   3-col unique gone · 4-col uq_plan_covered_service exists · two component-variants of one
--   (plan,service,pos) coexist · a true 4-col dup is rejected · benefit_corrections cols present.
-- =============================================================================

BEGIN;

-- ── PART A — plan_covered_services 3→4-col UNIQUE re-key (name-agnostic) ──────
-- The 3-col UNIQUE was declared INLINE in mig 009 (CREATE TABLE … UNIQUE(...)) so Postgres
-- auto-named it (e.g. plan_covered_services_insurance_plan_id_service_id_place_of_s_key). We
-- cannot DROP it by a hard-coded name across environments. Discover it by its exact column
-- set {insurance_plan_id, place_of_service, service_id} (sorted) and drop whatever it's named.
DO $$
DECLARE
  v_conname TEXT;
BEGIN
  SELECT con.conname
    INTO v_conname
  FROM pg_constraint con
  WHERE con.conrelid = 'plan_covered_services'::regclass
    AND con.contype = 'u'
    AND (
      SELECT array_agg(att.attname::text ORDER BY att.attname)   -- ::text: pg_attribute.attname is `name`; ARRAY[...] is text[]
      FROM unnest(con.conkey) AS k(attnum)
      JOIN pg_attribute att
        ON att.attrelid = con.conrelid
       AND att.attnum  = k.attnum
    ) = ARRAY['insurance_plan_id','place_of_service','service_id']
  LIMIT 1;

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE plan_covered_services DROP CONSTRAINT %I', v_conname);
    RAISE NOTICE 'mig 157: dropped 3-col plan_covered_services UNIQUE (%).', v_conname;
  ELSE
    RAISE NOTICE 'mig 157: no 3-col plan_covered_services UNIQUE found (already re-keyed?).';
  END IF;
END $$;

-- Idempotent add of the named 4-col key (drop-if-exists guards re-runs).
ALTER TABLE plan_covered_services DROP CONSTRAINT IF EXISTS uq_plan_covered_service;
ALTER TABLE plan_covered_services
  ADD CONSTRAINT uq_plan_covered_service
  UNIQUE (insurance_plan_id, service_id, place_of_service, component);

COMMENT ON CONSTRAINT uq_plan_covered_service ON plan_covered_services IS
  'S173 Thesaurus Phase 1a (mig 157): user-side cost-share cell identity = (insurance_plan_id, '
  'service_id, place_of_service, component). Parity with canonical_plan_services.uq_canonical_plan_service '
  '(mig 147). Every plan_covered_services upsert MUST target this 4-col key via '
  'src/lib/plan/coverage-targeting.ts (applyPlanCoverageCell) — a missing-axis write is a compile error.';

-- ── PART B — benefit_corrections cell-capture columns (additive; nullable) ───
-- place_of_service is intentionally left WITHOUT a CHECK: the authoritative validation is the
-- apply-time match against the service's EXISTING canonical cells (a correction's pos is only
-- meaningful if a matching cell exists). component carries the small fixed CHECK vocab.
ALTER TABLE benefit_corrections
  ADD COLUMN IF NOT EXISTS place_of_service TEXT,
  ADD COLUMN IF NOT EXISTS component        TEXT
    CHECK (component IS NULL OR component IN ('facility','professional','global'));

COMMENT ON COLUMN benefit_corrections.place_of_service IS
  'S173 Thesaurus Phase 1a (mig 157): the cost-share cell the user was viewing when they flagged '
  'the value. NULL until the /plan submit payload carries it (Backend→Frontend request). The apply '
  'handler uses (place_of_service, component) to target ONE canonical cell via apply_promotion_event — '
  'NULL + multi-cell service → reject (never a silent over-write of all variants).';
COMMENT ON COLUMN benefit_corrections.component IS
  'S173 Thesaurus Phase 1a (mig 157): facility|professional|global modifier of the flagged cell. '
  'See place_of_service comment.';

-- ── PART C — extend apply_promotion_event with the annual_limit typed-col arm ─
-- The benefit-correction apply path routes ALL fields through apply_promotion_event (the canonical
-- write authority — typed column + field_provenance synced atomically, S135 Path B). mig 148's body
-- synced copay/coinsurance/deductible_applies/is_covered/requires_prior_auth but NOT annual_limit
-- (canonical_plan_services.annual_limit INTEGER, mig 019:111) → an annual_limit correction would have
-- written provenance without the typed column (drift). This CREATE OR REPLACE adds the annual_limit
-- arm to BOTH the per-service INSERT and the ON CONFLICT UPDATE. Reproduced verbatim from mig 148;
-- the ONLY diffs are the annual_limit additions. SIGNATURE UNCHANGED -> CREATE OR REPLACE (no DROP;
-- GRANTs preserved). Behavior-preserving for every existing field/branch. (Whole-file paste in Studio:
-- the $$-quoted body's internal ';' are inside the dollar-quote — do not split.)
CREATE OR REPLACE FUNCTION apply_promotion_event(
  p_canonical_plan_id UUID,
  p_service_slug TEXT,
  p_field_name TEXT,
  p_corroborated_value JSONB,
  p_sources JSONB,
  p_fire_source TEXT,
  p_actor_user_id UUID DEFAULT NULL,
  p_force_event_type TEXT DEFAULT NULL,
  p_place_of_service TEXT DEFAULT 'any',
  p_component TEXT DEFAULT 'global'
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

  v_new_field_entry := jsonb_build_object(
    'value', p_corroborated_value, 'confidence', 0.9,
    'source', CASE WHEN v_event_type = 'admin_override' THEN 'admin_attested'
                   WHEN v_event_type = 'value_corrected_via_challenge' THEN 'challenge_resolution'
                   ELSE 'multi_source_corroboration' END,
    'corroborator_count', v_total_corroborator_count, 'sources', v_merged_sources, 'promoted_at', now());

  v_event_id := gen_random_uuid();

  IF v_target_table = 'canonical_plans' THEN
    -- UNCHANGED from mig 129 (plan-identity typed-col sync).
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
      confidence, source, field_provenance, copay, coinsurance, deductible_applies, is_covered, requires_prior_auth, annual_limit)
    VALUES (
      p_canonical_plan_id, p_service_slug, v_pos, v_component,
      0.9, CASE WHEN v_event_type='admin_override' THEN 'admin_attested' ELSE 'multi_source_corroboration' END,
      jsonb_build_object(p_field_name, v_new_field_entry),
      CASE WHEN p_field_name='copay' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE NULL END,
      CASE WHEN p_field_name='coinsurance' AND jsonb_typeof(p_corroborated_value)='number'
        THEN LEAST(1.0::NUMERIC, GREATEST(0.0::NUMERIC, CASE WHEN ((p_corroborated_value)::TEXT::NUMERIC)>1 THEN ((p_corroborated_value)::TEXT::NUMERIC)/100 ELSE (p_corroborated_value)::TEXT::NUMERIC END)) ELSE NULL END,
      CASE WHEN p_field_name='deductible_applies' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE NULL END,
      CASE WHEN p_field_name='is_covered' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE NULL END,
      CASE WHEN p_field_name='requires_prior_auth' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE NULL END,
      CASE WHEN p_field_name='annual_limit' AND jsonb_typeof(p_corroborated_value)='number' THEN ((p_corroborated_value)::TEXT::NUMERIC)::INTEGER ELSE NULL END)   -- mig 157: annual_limit arm
    ON CONFLICT (canonical_plan_id, service_slug, place_of_service, component) DO UPDATE SET
      field_provenance = jsonb_set(COALESCE(canonical_plan_services.field_provenance, '{}'::jsonb), ARRAY[p_field_name], v_new_field_entry, true),
      confidence = GREATEST(canonical_plan_services.confidence, 0.9),
      source = CASE WHEN v_event_type='admin_override' THEN 'admin_attested' ELSE 'multi_source_corroboration' END,
      copay = CASE WHEN p_field_name='copay' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE canonical_plan_services.copay END,
      coinsurance = CASE WHEN p_field_name='coinsurance' AND jsonb_typeof(p_corroborated_value)='number'
        THEN LEAST(1.0::NUMERIC, GREATEST(0.0::NUMERIC, CASE WHEN ((p_corroborated_value)::TEXT::NUMERIC)>1 THEN ((p_corroborated_value)::TEXT::NUMERIC)/100 ELSE (p_corroborated_value)::TEXT::NUMERIC END)) ELSE canonical_plan_services.coinsurance END,
      deductible_applies = CASE WHEN p_field_name='deductible_applies' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE canonical_plan_services.deductible_applies END,
      is_covered = CASE WHEN p_field_name='is_covered' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE canonical_plan_services.is_covered END,
      requires_prior_auth = CASE WHEN p_field_name='requires_prior_auth' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE canonical_plan_services.requires_prior_auth END,
      annual_limit = CASE WHEN p_field_name='annual_limit' AND jsonb_typeof(p_corroborated_value)='number' THEN ((p_corroborated_value)::TEXT::NUMERIC)::INTEGER ELSE canonical_plan_services.annual_limit END,   -- mig 157: annual_limit arm
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

COMMENT ON FUNCTION apply_promotion_event(UUID, TEXT, TEXT, JSONB, JSONB, TEXT, UUID, TEXT, TEXT, TEXT) IS
  'S167 Thesaurus (mig 148) + mig 157: canonical promotion writer, cell-aware (4-col), typed column + field_provenance synced atomically. mig 157 added the annual_limit arm (canonical_plan_services.annual_limit INTEGER) to the per-service INSERT + ON CONFLICT UPDATE so the benefit-correction apply path (admin_override) keeps annual_limit in sync. Behavior-preserving for every other field/branch.';

COMMIT;
