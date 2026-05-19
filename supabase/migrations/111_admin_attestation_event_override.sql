-- Migration 111: Admin attestation event_type override + cf40_v4_layer_5_only flag
--
-- Purpose: enable admin cold-start seeding by allowing apply_promotion_event to
-- emit canonical_promotion_events.event_type='admin_override' (already a valid
-- CHECK value from mig 068) when an admin uploads a document, bypassing the
-- Pattern 1 #3 corroboration threshold.
--
-- Why this matters: with one test user (Andrew) and threshold=3 distinct users,
-- no canonical has ever reached promotion. canonical_plan_services has zero
-- rows globally → services-drift NO_OP guard fires every parse → stability
-- counter pinned at 1 → smart-skip + hash-dedup architecturally dormant.
--
-- This mig provides the Postgres function side of the admin bypass. The TS
-- side (commit-and-evaluate.ts admin-detection branch) is in the same PR.
--
-- Pattern 1 #14 compliance: admin attestation is still an explicit promotion
-- event (Pattern 1 #14 §"canonical via explicit promotion"). event_type
-- distinguishes admin-attested ('admin_override') from organic three-user
-- corroboration ('first_promotion'/'corroboration_added') for audit trail.
--
-- Also seeds the cf40_v4_layer_5_only feature flag (default OFF) for the
-- follow-on session that wires Layer 5 drift sampling.

-- ── Part 1: amend apply_promotion_event with optional force_event_type ──
-- Backward compatible: existing callers pass nothing → existing behavior.
-- New callers (admin bypass branch in commit-and-evaluate.ts) pass
-- 'admin_override' to override the computed first_promotion/corroboration_added.

CREATE OR REPLACE FUNCTION apply_promotion_event(
  p_canonical_plan_id UUID,
  p_service_slug TEXT,
  p_field_name TEXT,
  p_corroborated_value JSONB,
  p_sources JSONB,
  p_fire_source TEXT,
  p_actor_user_id UUID DEFAULT NULL,
  p_force_event_type TEXT DEFAULT NULL
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
BEGIN
  -- ── 0. Validate inputs + resolve target table ──
  IF p_canonical_plan_id IS NULL OR p_field_name IS NULL OR p_corroborated_value IS NULL THEN
    RAISE EXCEPTION 'apply_promotion_event: canonical_plan_id, field_name, corroborated_value are required';
  END IF;

  IF p_force_event_type IS NOT NULL
     AND p_force_event_type NOT IN ('first_promotion', 'corroboration_added', 'value_corrected_via_challenge', 'admin_override') THEN
    RAISE EXCEPTION 'apply_promotion_event: invalid p_force_event_type = %; must be one of first_promotion, corroboration_added, value_corrected_via_challenge, admin_override', p_force_event_type;
  END IF;

  v_target_table := CASE WHEN p_service_slug IS NULL THEN 'canonical_plans' ELSE 'canonical_plan_services' END;

  -- ── Load top-K bound from flag config ──
  SELECT (config->>'sources_array_max_k')::INT INTO v_max_k
  FROM feature_flag_rules
  WHERE flag_key = 'canonical_promotion_event_v1';
  v_max_k := COALESCE(v_max_k, 5);

  -- ── 1. Acquire advisory lock for (canonical, service, field) ──
  v_lock_key := hashtextextended(
    p_canonical_plan_id::TEXT || COALESCE(p_service_slug, '_') || p_field_name,
    0
  );
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- ── 2. Read existing canonical row ──
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
    FOR UPDATE;
    -- May not exist yet (first promotion creates the row in the INSERT below).
  END IF;

  v_existing_field_entry := COALESCE(v_existing_provenance->p_field_name, '{}'::jsonb);
  v_current_confidence := COALESCE((v_existing_field_entry->>'confidence')::NUMERIC, 0);
  v_current_corroborator_count := COALESCE((v_existing_field_entry->>'corroborator_count')::INT, 0);
  v_existing_sources := COALESCE(v_existing_field_entry->'sources', '[]'::jsonb);

  -- ── 3. Determine event type ──
  -- If caller forced a value (admin bypass path), use it. Otherwise compute
  -- organically: first_promotion when confidence < 0.9, else corroboration_added.
  IF p_force_event_type IS NOT NULL THEN
    v_event_type := p_force_event_type;
  ELSIF COALESCE(v_current_confidence, 0) < 0.9 THEN
    v_event_type := 'first_promotion';
  ELSE
    v_event_type := 'corroboration_added';
  END IF;

  -- ── 4. Compute total corroborator count (deduped by user_id_hash) ──
  WITH all_hashes AS (
    SELECT DISTINCT (entry->>'user_id_hash') AS h
    FROM jsonb_array_elements(v_existing_sources || COALESCE(p_sources, '[]'::jsonb)) AS entries(entry)
  )
  SELECT COUNT(*) INTO v_total_corroborator_count FROM all_hashes;

  -- ── 5. Build merged sources array (top-K; first-K-arrived) ──
  WITH unioned AS (
    SELECT DISTINCT ON (entry->>'user_id_hash')
      entry
    FROM jsonb_array_elements(v_existing_sources || COALESCE(p_sources, '[]'::jsonb)) AS entries(entry)
    ORDER BY entry->>'user_id_hash', (entry->>'recorded_at')::TIMESTAMPTZ NULLS LAST
  ),
  ordered AS (
    SELECT entry FROM unioned ORDER BY (entry->>'recorded_at')::TIMESTAMPTZ NULLS LAST
    LIMIT v_max_k
  )
  SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb) INTO v_merged_sources FROM ordered;

  v_sources_added := jsonb_array_length(v_merged_sources) - jsonb_array_length(v_existing_sources);
  IF v_sources_added < 0 THEN v_sources_added := 0; END IF;

  -- ── 6. Build new field_provenance entry ──
  v_new_field_entry := jsonb_build_object(
    'value', p_corroborated_value,
    'confidence', 0.9,
    'source', CASE
      WHEN v_event_type = 'admin_override' THEN 'admin_attested'
      WHEN v_event_type = 'value_corrected_via_challenge' THEN 'challenge_resolution'
      ELSE 'multi_source_corroboration'
    END,
    'corroborator_count', v_total_corroborator_count,
    'sources', v_merged_sources,
    'promoted_at', now()
  );

  -- ── 7. Write canonical row ──
  v_event_id := gen_random_uuid();

  IF v_target_table = 'canonical_plans' THEN
    UPDATE canonical_plans
    SET
      field_provenance = jsonb_set(
        COALESCE(field_provenance, '{}'::jsonb),
        ARRAY[p_field_name],
        v_new_field_entry,
        true
      ),
      updated_at = now()
    WHERE id = p_canonical_plan_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'apply_promotion_event: canonical_plans row % not found (concurrent DELETE?)', p_canonical_plan_id;
    END IF;

  ELSE
    -- Upsert to canonical_plan_services (row may not exist yet pre-promotion)
    INSERT INTO canonical_plan_services (
      canonical_plan_id,
      service_slug,
      confidence,
      source,
      field_provenance
    )
    VALUES (
      p_canonical_plan_id,
      p_service_slug,
      0.9,
      CASE WHEN v_event_type = 'admin_override' THEN 'admin_attested' ELSE 'multi_source_corroboration' END,
      jsonb_build_object(p_field_name, v_new_field_entry)
    )
    ON CONFLICT (canonical_plan_id, service_slug) DO UPDATE
      SET
        field_provenance = jsonb_set(
          COALESCE(canonical_plan_services.field_provenance, '{}'::jsonb),
          ARRAY[p_field_name],
          v_new_field_entry,
          true
        ),
        confidence = GREATEST(canonical_plan_services.confidence, 0.9),
        source = CASE
          WHEN v_event_type = 'admin_override' THEN 'admin_attested'
          ELSE 'multi_source_corroboration'
        END,
        updated_at = now();
  END IF;

  -- ── 8. Insert event log row ──
  INSERT INTO canonical_promotion_events (
    id,
    canonical_plan_id,
    service_slug,
    field_name,
    event_type,
    fire_source,
    corroborator_count,
    sources_count,
    corroborated_value,
    actor_user_id,
    fired_at
  )
  VALUES (
    v_event_id,
    p_canonical_plan_id,
    p_service_slug,
    p_field_name,
    v_event_type,
    p_fire_source,
    v_total_corroborator_count,
    v_sources_added,
    p_corroborated_value,
    p_actor_user_id,
    now()
  );

  RETURN v_event_id;
END;
$$;

COMMENT ON FUNCTION apply_promotion_event(UUID, TEXT, TEXT, JSONB, JSONB, TEXT, UUID, TEXT) IS
  'Phase 4.0.6 (Session 60) + S102 (admin attestation extension). Atomically writes corroborated value at 0.9 confidence to canonical field_provenance + appends top-K sources (deduped by user_id_hash) + increments corroborator_count + inserts canonical_promotion_events log row. Race-aware via advisory lock per (canonical_plan_id, service_slug, field_name). service_slug IS NULL targets canonical_plans; otherwise canonical_plan_services. p_force_event_type: if non-null, overrides computed event type (first_promotion / corroboration_added). Used by admin bypass path (S102, commit-and-evaluate.ts) to emit admin_override events without meeting the Pattern 1 #3 distinct-user threshold. Pattern 1 #14 compliance preserved: admin attestation is still an explicit promotion event, distinguished in audit trail by event_type=admin_override.';

-- ── Part 2: cf40_v4_layer_5_only feature flag (default OFF, global) ──
-- Independent of cf40_v4_algorithm (which gates the full v4 algorithm,
-- currently a telemetry stub). This flag gates JUST Layer 5 drift sampling
-- (the wiring of decideForcedReparse into shouldSkipExtraction). Enables
-- activating drift sampling without flipping the broader v4 algorithm.

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'cf40_v4_layer_5_only',
  false,
  'S102 (S73.5 D2b follow-on). Independent gate for v4 Layer 5 drift sampling (forced re-parse triggers: admin uploads, statistical random sample, temporal staleness, every-5th-smart-skip, verification mode). Separated from cf40_v4_algorithm so we can activate drift sampling without flipping the full v4 algorithm (which is still a telemetry stub for Layers 3/4). Flip ON after admin cold-start seeding completes + Layer 5 wiring lands in shouldSkipExtraction.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
