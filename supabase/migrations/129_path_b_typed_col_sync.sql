-- Migration 129: RC-3 Path B PR #1 — typed-column denormalized-cache sync
-- inside apply_promotion_event
--
-- Per plans/rc-3-reconciliation.md (S135 backend, 2026-05-27) + plans/rc-3-path-b-pr-1-scope.md.
--
-- WHY THIS MIGRATION EXISTS
--
-- Mig 068 (Phase 4.0.6) introduced canonical_plans.field_provenance + the
-- apply_promotion_event RPC that writes corroborated values to JSONB at 0.9
-- confidence. Mig 111 extended the RPC with admin_override support. Both migs
-- update field_provenance JSONB but DO NOT update the typed-column
-- denormalized cache on canonical_plans (deductible_individual, oop_max_*, etc.)
-- or canonical_plan_services (copay, coinsurance, deductible_applies, etc.).
--
-- Mig 068 comment line 89-92 calls typed columns "denormalized cache;
-- field_provenance authoritative for confidence gating." But empirical PROD
-- audit (2026-05-27) showed downstream consumer code reads typed columns:
-- /api/plan/analyze/route.ts reads userPlan.in_deductible_individual; the
-- canonical-service-inheritance code at process-plan.ts:1483-1487 reads
-- canonical_plan_services.copay + .coinsurance + .deductible_applies. If
-- typed cols drift from JSONB, consumers get stale data + correct provenance
-- badges. PROD audit measured 2.5–7% drift on canonical_plans plan-identity
-- scalars and 0.1–70% drift on canonical_plan_services service fields,
-- with deductible_applies at 70% as the headline.
--
-- WHAT THIS MIGRATION ADDS
--
-- CREATE OR REPLACE apply_promotion_event with typed-column sync logic
-- inside the same atomic advisory-lock-held transaction. Specifically:
--
-- 1. For canonical_plans target: UPDATE adds CASE expressions for each
--    promotable plan-identity typed column (deductible_individual,
--    deductible_family, oop_max_individual, oop_max_family, plan_name,
--    plan_year, plan_type, metal_level). Each CASE fires only when
--    p_field_name matches and jsonb_typeof(p_corroborated_value) matches
--    expected type. Otherwise preserves existing typed col value (silent
--    skip — defense against future JSONB type drift).
--
-- 2. For canonical_plan_services target: same CASE pattern in both the
--    INSERT VALUES (first-time promotion path; row didn't exist before) and
--    the ON CONFLICT DO UPDATE SET clause (subsequent promotion path).
--    Fields: copay, coinsurance, deductible_applies, is_covered,
--    requires_prior_auth. Coinsurance has inline normalization to decimal
--    [0, 1] matching normalizeCoinsuranceForStorage TS semantics
--    (raw > 1 → raw / 100; clamp [0, 1]) — closes the empirical
--    mixed-encoding state in PROD where ~50% of corroborated JSONB
--    coinsurance values are integer-percent despite typed cols being
--    consistently decimal.
--
-- 3. NO new table. The skip-telemetry table (canonical_typed_col_sync_skips)
--    proposed in early scoping was CUT per S135 critical review — JSONB
--    types are 100% consistent per spot-check; expected skip rate ≈ 0; the
--    table would mirror the canonical_match_decisions empty-table failure
--    mode. Detection mechanism = periodic G2 audit query
--    (scripts/findings/rc-3-audit-v2.ts) re-run post-deploy + ad-hoc
--    Postgres log inspection if drift % climbs.
--
-- 4. Backward compatible signature — all 8 parameters preserved. Existing
--    callers pass nothing new. Returns UUID (event_id). All existing
--    behavior (advisory lock per (canonical, service, field), event log
--    write to canonical_promotion_events, p_force_event_type override,
--    'admin_attested' source value when admin_override, FOR UPDATE row
--    lock, top-K source merging deduped by user_id_hash) preserved
--    byte-identical with the typed-col sync added inline.
--
-- 5. Sister code change in same PR: src/lib/parser/commit-and-evaluate.ts
--    adds 'metal_level' to PHASE_4_0_6_PLAN_IDENTITY_FIELDS_SBC + _EOC so
--    metal_level enters the corroboration evaluator at all (latent gap;
--    canonical_plans.metal_level typed col exists but never gets promoted
--    today because the candidates list doesn't include it).
--
-- BACKOUT
--
-- Re-apply mig 111's apply_promotion_event definition (preserve typed cols
-- as denormalized cache; JSONB writes still happen via the same path).
-- Schema unchanged (function body only); CREATE OR REPLACE is idempotent.
-- Typed cols that were synced post-mig-129 stay at the synced value
-- (no rollback needed; correct values preserved). New rows post-rollback
-- would resume drifting until a follow-up backfill or re-apply of mig 129.
--
-- ROLLOUT
--
-- 1. Andrew applies mig 129 to PROD via Supabase Studio pre-PR-merge
--    (matches mig 127 pattern).
-- 2. PR opens with smoke evidence (tsc/lint/build clean + fixture 20/20 PASS).
-- 3. PR squash-merges to main; sits on main.
-- 4. PR #2 backfill (separate PR, sister scope doc at
--    plans/rc-3-path-b-pr-2-backfill-scope.md) opens + ships.
-- 5. Bundle PROD-promote PR #1 + PR #2 (Q3 final).
-- 6. Post-promote: re-run audit query — expect 0% drift on newly-promoted
--    rows. 24h soak. 7-day soak. Done.

BEGIN;

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

  -- ── 2. Read existing canonical row (FOR UPDATE per mig 111) ──
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

  -- ── 7. Write canonical row (UPDATE field_provenance JSONB + typed-col sync inline) ──
  v_event_id := gen_random_uuid();

  IF v_target_table = 'canonical_plans' THEN
    -- Path B PR #1: extend the existing UPDATE to also sync typed columns.
    -- Each CASE fires only when p_field_name matches AND jsonb_typeof matches
    -- expected. Otherwise preserves existing typed col value (silent skip).
    -- Defense against future JSONB type drift; today's audit shows 100%
    -- consistent JSONB types so the guards stay quiet.
    UPDATE canonical_plans
    SET
      field_provenance = jsonb_set(
        COALESCE(field_provenance, '{}'::jsonb),
        ARRAY[p_field_name],
        v_new_field_entry,
        true
      ),
      -- Plan-identity scalar typed-col sync (Path B PR #1):
      deductible_individual = CASE
        WHEN p_field_name = 'in_deductible_individual' AND jsonb_typeof(p_corroborated_value) = 'number'
          THEN (p_corroborated_value)::TEXT::NUMERIC
        ELSE deductible_individual
      END,
      deductible_family = CASE
        WHEN p_field_name = 'in_deductible_family' AND jsonb_typeof(p_corroborated_value) = 'number'
          THEN (p_corroborated_value)::TEXT::NUMERIC
        ELSE deductible_family
      END,
      oop_max_individual = CASE
        WHEN p_field_name = 'in_oop_max_individual' AND jsonb_typeof(p_corroborated_value) = 'number'
          THEN (p_corroborated_value)::TEXT::NUMERIC
        ELSE oop_max_individual
      END,
      oop_max_family = CASE
        WHEN p_field_name = 'in_oop_max_family' AND jsonb_typeof(p_corroborated_value) = 'number'
          THEN (p_corroborated_value)::TEXT::NUMERIC
        ELSE oop_max_family
      END,
      plan_name = CASE
        WHEN p_field_name = 'plan_name' AND jsonb_typeof(p_corroborated_value) = 'string'
          THEN (p_corroborated_value)#>>'{}'
        ELSE plan_name
      END,
      plan_year = CASE
        WHEN p_field_name = 'plan_year' AND jsonb_typeof(p_corroborated_value) = 'number'
          THEN ((p_corroborated_value)::TEXT::NUMERIC)::INT
        ELSE plan_year
      END,
      plan_type = CASE
        WHEN p_field_name = 'plan_type' AND jsonb_typeof(p_corroborated_value) = 'string'
          THEN (p_corroborated_value)#>>'{}'
        ELSE plan_type
      END,
      metal_level = CASE
        WHEN p_field_name = 'metal_level' AND jsonb_typeof(p_corroborated_value) = 'string'
          THEN (p_corroborated_value)#>>'{}'
        ELSE metal_level
      END,
      updated_at = now()
    WHERE id = p_canonical_plan_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'apply_promotion_event: canonical_plans row % not found (concurrent DELETE?)', p_canonical_plan_id;
    END IF;

  ELSE
    -- canonical_plan_services: INSERT path (first promotion) writes typed col
    -- for the promoted field; NULL for others (row didn't exist before). ON
    -- CONFLICT path updates the typed col for the promoted field; preserves
    -- others via CASE.
    --
    -- Coinsurance normalization to decimal [0, 1] mirrors
    -- normalizeCoinsuranceForStorage TS semantics:
    --   raw <= 0 → 0
    --   raw > 1  → raw / 100 (Claude returned integer-percent; convert)
    --   raw ≤ 1  → raw (already decimal)
    --   clamp [0, 1]
    INSERT INTO canonical_plan_services (
      canonical_plan_id,
      service_slug,
      confidence,
      source,
      field_provenance,
      copay,
      coinsurance,
      deductible_applies,
      is_covered,
      requires_prior_auth
    )
    VALUES (
      p_canonical_plan_id,
      p_service_slug,
      0.9,
      CASE WHEN v_event_type = 'admin_override' THEN 'admin_attested' ELSE 'multi_source_corroboration' END,
      jsonb_build_object(p_field_name, v_new_field_entry),
      -- Typed-col sync at INSERT path (first promotion creates the row):
      CASE
        WHEN p_field_name = 'copay' AND jsonb_typeof(p_corroborated_value) = 'number'
          THEN (p_corroborated_value)::TEXT::NUMERIC
        ELSE NULL
      END,
      CASE
        WHEN p_field_name = 'coinsurance' AND jsonb_typeof(p_corroborated_value) = 'number' THEN
          LEAST(1.0::NUMERIC, GREATEST(0.0::NUMERIC,
            CASE
              WHEN ((p_corroborated_value)::TEXT::NUMERIC) > 1
                THEN ((p_corroborated_value)::TEXT::NUMERIC) / 100
              ELSE (p_corroborated_value)::TEXT::NUMERIC
            END
          ))
        ELSE NULL
      END,
      CASE
        WHEN p_field_name = 'deductible_applies' AND jsonb_typeof(p_corroborated_value) = 'boolean'
          THEN (p_corroborated_value)::TEXT::BOOLEAN
        ELSE NULL
      END,
      CASE
        WHEN p_field_name = 'is_covered' AND jsonb_typeof(p_corroborated_value) = 'boolean'
          THEN (p_corroborated_value)::TEXT::BOOLEAN
        ELSE NULL
      END,
      CASE
        WHEN p_field_name = 'requires_prior_auth' AND jsonb_typeof(p_corroborated_value) = 'boolean'
          THEN (p_corroborated_value)::TEXT::BOOLEAN
        ELSE NULL
      END
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
        -- Typed-col sync at ON CONFLICT UPDATE path (subsequent promotions):
        copay = CASE
          WHEN p_field_name = 'copay' AND jsonb_typeof(p_corroborated_value) = 'number'
            THEN (p_corroborated_value)::TEXT::NUMERIC
          ELSE canonical_plan_services.copay
        END,
        coinsurance = CASE
          WHEN p_field_name = 'coinsurance' AND jsonb_typeof(p_corroborated_value) = 'number' THEN
            LEAST(1.0::NUMERIC, GREATEST(0.0::NUMERIC,
              CASE
                WHEN ((p_corroborated_value)::TEXT::NUMERIC) > 1
                  THEN ((p_corroborated_value)::TEXT::NUMERIC) / 100
                ELSE (p_corroborated_value)::TEXT::NUMERIC
              END
            ))
          ELSE canonical_plan_services.coinsurance
        END,
        deductible_applies = CASE
          WHEN p_field_name = 'deductible_applies' AND jsonb_typeof(p_corroborated_value) = 'boolean'
            THEN (p_corroborated_value)::TEXT::BOOLEAN
          ELSE canonical_plan_services.deductible_applies
        END,
        is_covered = CASE
          WHEN p_field_name = 'is_covered' AND jsonb_typeof(p_corroborated_value) = 'boolean'
            THEN (p_corroborated_value)::TEXT::BOOLEAN
          ELSE canonical_plan_services.is_covered
        END,
        requires_prior_auth = CASE
          WHEN p_field_name = 'requires_prior_auth' AND jsonb_typeof(p_corroborated_value) = 'boolean'
            THEN (p_corroborated_value)::TEXT::BOOLEAN
          ELSE canonical_plan_services.requires_prior_auth
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
  'Phase 4.0.6 (Session 60) + S102 (admin attestation extension) + S135 RC-3 Path B PR #1 (typed-col denormalized-cache sync, mig 129). Atomically writes corroborated value at 0.9 confidence to canonical field_provenance JSONB + syncs the matching typed-column denormalized cache + appends top-K sources (deduped by user_id_hash) + increments corroborator_count + inserts canonical_promotion_events log row. Race-aware via advisory lock per (canonical_plan_id, service_slug, field_name). service_slug IS NULL targets canonical_plans (8 plan-identity fields synced); otherwise canonical_plan_services (5 service fields synced; coinsurance normalized to decimal [0, 1] inline). p_force_event_type: if non-null, overrides computed event type (first_promotion / corroboration_added). Typed-col sync uses jsonb_typeof guards — silent skip on type mismatch preserves existing typed col value (defense against future JSONB type drift). Pattern 1 #14 compliance preserved: typed-col writes happen inside apply_promotion_event (service_role grant) — not user-driven writes.';

COMMIT;
