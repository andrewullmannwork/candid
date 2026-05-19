-- =============================================================================
-- MIGRATION 108 — Pattern 1 #3 corroboration: concept_id-grouped counting
-- (S99 B5 housekeeping carry-forward from S94 Stage 3)
-- =============================================================================
--
-- Modifies evaluate_pattern1_corroboration to count distinct users across ALL
-- service_catalog rows sharing the same concept_id, rather than only rows whose
-- slug matches the input parameter exactly. Closes the latent Pattern 1 #3
-- silent-split bug that would activate the moment admin promotes a proposed_*
-- slug as an ALIAS of an existing canonical (S94 triplet authority architecture
-- shipped in mig 103).
--
-- WHY:
--   S94 (mig 103) introduced canonical_for_concept BOOLEAN + proposal_state
--   on service_catalog. Multiple slug rows can share one concept_id; exactly
--   one row per concept is canonical_for_concept=TRUE. After S95 reset, all
--   68 rows are canonical (no aliases) — so mig 108's behavior is identical
--   to mig 076 for current PROD data.
--
--   The bug activates when admin promotes the first alias. Without mig 108:
--     - User A uploads doc with slug 'pt_rehab' (canonical)
--     - Users B, C upload docs with slug 'physical_therapy' (admin-promoted
--       alias of pt_rehab; same concept_id)
--     - evaluate_pattern1_corroboration('pt_rehab', ...) sees 1 user → no promotion
--     - evaluate_pattern1_corroboration('physical_therapy', ...) sees 2 users → no promotion
--     - Neither reaches the 3-user threshold; corroboration SILENTLY SPLITS
--
--   With mig 108: both calls JOIN service_catalog, gather all siblings of the
--   input slug's concept_id, and COUNT distinct users across all sibling
--   rows. Both calls now report 3 distinct users → promotion fires.
--
-- WHAT CHANGES:
--   1. evaluate_pattern1_corroboration now:
--      - Resolves input slug → its concept_id (single SELECT at function top)
--      - Gathers all sibling slugs sharing that concept_id (array_agg)
--      - Filters WHERE sc.slug = ANY(v_sibling_slugs) instead of = p_service_slug
--      - Reads canonical_plan_services by canonical sibling slug (not input)
--      - Returns canonical_service_slug in JSONB response so callers know
--        which slug to pass to apply_promotion_event
--   2. JSONB response shape extends additively (existing consumers unaffected).
--   3. Fall-through behavior: if input slug isn't in service_catalog OR has
--      NULL concept_id, function behaves exactly as mig 076 (single-slug match;
--      canonical_service_slug = input slug). Preserves legacy compatibility.
--
-- TS CALLER UPDATE (in same PR):
--   commitUploadAndEvaluateCorroboration uses decision.canonical_service_slug
--   when calling applyPromotionEvent so canonical_plan_services writes land on
--   the canonical row (not the alias).
--
-- BACKOUT:
--   Re-run mig 076's function definition. Schema is unchanged (function body
--   only); function CREATE OR REPLACE is idempotent.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION evaluate_pattern1_corroboration(
  p_canonical_plan_id UUID,
  p_service_slug TEXT,
  p_field_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_threshold INT;
  v_max_k INT;
  v_distinct_user_count INT := 0;
  v_max_value_count INT := 0;
  v_corroborated_value JSONB;
  v_corroborator_excerpts JSONB := '[]'::jsonb;
  v_current_canonical_confidence NUMERIC;
  v_canonical_current_value JSONB;
  v_target_table TEXT;
  -- S99 B5 (mig 108): concept_id grouping
  v_concept_id UUID;
  v_canonical_service_slug TEXT;
  v_sibling_slugs TEXT[];
BEGIN
  -- ── Read tunable config from feature flag ──
  SELECT (config->>'corroboration_threshold')::INT INTO v_threshold
    FROM feature_flag_rules
    WHERE flag_key = 'canonical_promotion_event_v1';
  IF v_threshold IS NULL THEN
    SELECT (config->>'value')::INT INTO v_threshold
      FROM feature_flag_rules
      WHERE flag_key = 'pattern1_corroboration_threshold';
    IF v_threshold IS NULL THEN
      v_threshold := 3;
    END IF;
  END IF;

  SELECT (config->>'sources_array_max_k')::INT INTO v_max_k
    FROM feature_flag_rules
    WHERE flag_key = 'canonical_promotion_event_v1';
  IF v_max_k IS NULL OR v_max_k < 1 THEN
    v_max_k := 5;
  END IF;

  -- ── S99 B5: resolve input slug to canonical + sibling slugs ──
  -- For plan-identity fields (p_service_slug IS NULL), this block is skipped;
  -- v_canonical_service_slug remains NULL and the plan-identity branch below
  -- runs unchanged.
  --
  -- For per-service fields:
  --   1. Look up input slug's concept_id
  --   2. Find the canonical sibling slug (canonical_for_concept=TRUE)
  --   3. Gather ALL sibling slugs (canonical + aliases) sharing the concept
  --
  -- Fall-through behavior (slug not in catalog OR concept_id IS NULL):
  -- treat the input slug as its own canonical with one sibling = itself.
  -- Preserves mig 076 behavior for legacy data.
  IF p_service_slug IS NOT NULL THEN
    SELECT concept_id INTO v_concept_id
    FROM service_catalog
    WHERE slug = p_service_slug;

    IF v_concept_id IS NOT NULL THEN
      SELECT slug INTO v_canonical_service_slug
      FROM service_catalog
      WHERE concept_id = v_concept_id
        AND canonical_for_concept = TRUE
      LIMIT 1;

      SELECT array_agg(slug) INTO v_sibling_slugs
      FROM service_catalog
      WHERE concept_id = v_concept_id;
    END IF;

    -- Fall-through: input slug not in catalog OR has NULL concept_id OR has
    -- no canonical sibling (the enforce_canonical_per_concept trigger should
    -- prevent the last case, but defensive null-coalesce here).
    IF v_canonical_service_slug IS NULL THEN
      v_canonical_service_slug := p_service_slug;
      v_sibling_slugs := ARRAY[p_service_slug];
    END IF;
  END IF;

  -- ── Branch on target user-side table ──
  IF p_service_slug IS NULL THEN
    v_target_table := 'insurance_plans';

    -- Plan-identity field corroboration: query insurance_plans directly
    -- JOIN users + filter email_verified=TRUE AND phone_verified=TRUE
    -- (unchanged from mig 076 — plan-identity has no service_slug grouping)
    WITH user_values AS (
      SELECT DISTINCT ON (ip.user_id)
        ip.user_id,
        ip.field_provenance->p_field_name->'value' AS extracted_value,
        ip.field_provenance->p_field_name->>'source_excerpt' AS excerpt,
        ip.id AS doc_ref_id,
        COALESCE(
          ip.field_provenance->p_field_name->>'last_corroborated_at',
          ip.created_at::TEXT
        ) AS recorded_at
      FROM insurance_plans ip
      JOIN users u ON u.id = ip.user_id
      WHERE ip.canonical_plan_id = p_canonical_plan_id
        AND u.email_verified = TRUE
        AND u.phone_verified = TRUE
        AND ip.field_provenance ? p_field_name
        AND ip.field_provenance->p_field_name ? 'value'
        AND jsonb_typeof(ip.field_provenance->p_field_name->'value') NOT IN ('null')
        AND (ip.field_provenance->p_field_name->>'source_excerpt_verified') = 'verified'
      ORDER BY ip.user_id, ip.created_at
    ),
    value_groups AS (
      SELECT extracted_value, COUNT(*) AS cnt
      FROM user_values
      GROUP BY extracted_value
    ),
    max_group AS (
      SELECT extracted_value, cnt
      FROM value_groups
      ORDER BY cnt DESC, extracted_value::TEXT
      LIMIT 1
    )
    SELECT
      (SELECT COUNT(*) FROM user_values),
      (SELECT cnt FROM max_group),
      (SELECT extracted_value FROM max_group),
      (
        SELECT COALESCE(jsonb_agg(s ORDER BY s->>'recorded_at'), '[]'::jsonb)
        FROM (
          SELECT jsonb_build_object(
            'user_id_hash', encode(
              digest(
                user_id::TEXT || ':' || p_canonical_plan_id::TEXT || ':' || COALESCE(p_service_slug, '') || ':' || p_field_name,
                'sha256'
              ),
              'hex'
            ),
            'excerpt', excerpt,
            'document_ref', doc_ref_id::TEXT,
            'recorded_at', recorded_at
          ) AS s
          FROM user_values
          WHERE extracted_value = (SELECT extracted_value FROM max_group)
          ORDER BY recorded_at
          LIMIT v_max_k
        ) top_k
      )
    INTO
      v_distinct_user_count,
      v_max_value_count,
      v_corroborated_value,
      v_corroborator_excerpts;

    SELECT
      (cp.field_provenance->p_field_name->>'confidence')::NUMERIC,
      cp.field_provenance->p_field_name->'value'
    INTO v_current_canonical_confidence, v_canonical_current_value
    FROM canonical_plans cp
    WHERE cp.id = p_canonical_plan_id;

  ELSE
    v_target_table := 'plan_covered_services';

    -- Per-service field corroboration: query plan_covered_services JOIN insurance_plans
    -- JOIN users + filter email_verified=TRUE AND phone_verified=TRUE
    -- S99 B5: WHERE sc.slug = ANY(v_sibling_slugs) (concept_id-grouped); also
    -- include service_id-based join so we don't double-count user rows in cases
    -- where pcs.service_id points to the alias row vs canonical row (each row
    -- still represents one (user, slug) attestation).
    WITH user_values AS (
      SELECT DISTINCT ON (ip.user_id)
        ip.user_id,
        pcs.field_provenance->p_field_name->'value' AS extracted_value,
        pcs.field_provenance->p_field_name->>'source_excerpt' AS excerpt,
        pcs.id AS doc_ref_id,
        COALESCE(
          pcs.field_provenance->p_field_name->>'last_corroborated_at',
          pcs.created_at::TEXT
        ) AS recorded_at
      FROM plan_covered_services pcs
      JOIN insurance_plans ip ON ip.id = pcs.insurance_plan_id
      JOIN users u ON u.id = ip.user_id
      JOIN service_catalog sc ON sc.id = pcs.service_id
      WHERE ip.canonical_plan_id = p_canonical_plan_id
        AND u.email_verified = TRUE
        AND u.phone_verified = TRUE
        AND sc.slug = ANY(v_sibling_slugs)
        AND pcs.field_provenance ? p_field_name
        AND pcs.field_provenance->p_field_name ? 'value'
        AND jsonb_typeof(pcs.field_provenance->p_field_name->'value') NOT IN ('null')
        AND (pcs.field_provenance->p_field_name->>'source_excerpt_verified') = 'verified'
      ORDER BY ip.user_id, pcs.created_at
    ),
    value_groups AS (
      SELECT extracted_value, COUNT(*) AS cnt
      FROM user_values
      GROUP BY extracted_value
    ),
    max_group AS (
      SELECT extracted_value, cnt
      FROM value_groups
      ORDER BY cnt DESC, extracted_value::TEXT
      LIMIT 1
    )
    SELECT
      (SELECT COUNT(*) FROM user_values),
      (SELECT cnt FROM max_group),
      (SELECT extracted_value FROM max_group),
      (
        SELECT COALESCE(jsonb_agg(s ORDER BY s->>'recorded_at'), '[]'::jsonb)
        FROM (
          SELECT jsonb_build_object(
            'user_id_hash', encode(
              digest(
                user_id::TEXT || ':' || p_canonical_plan_id::TEXT || ':' || COALESCE(p_service_slug, '') || ':' || p_field_name,
                'sha256'
              ),
              'hex'
            ),
            'excerpt', excerpt,
            'document_ref', doc_ref_id::TEXT,
            'recorded_at', recorded_at
          ) AS s
          FROM user_values
          WHERE extracted_value = (SELECT extracted_value FROM max_group)
          ORDER BY recorded_at
          LIMIT v_max_k
        ) top_k
      )
    INTO
      v_distinct_user_count,
      v_max_value_count,
      v_corroborated_value,
      v_corroborator_excerpts;

    -- S99 B5: read canonical_plan_services row by canonical sibling slug, not
    -- the input slug. If input was an alias, this finds the canonical's row.
    SELECT
      (cps.field_provenance->p_field_name->>'confidence')::NUMERIC,
      cps.field_provenance->p_field_name->'value'
    INTO v_current_canonical_confidence, v_canonical_current_value
    FROM canonical_plan_services cps
    WHERE cps.canonical_plan_id = p_canonical_plan_id
      AND cps.service_slug = v_canonical_service_slug;
  END IF;

  -- ── Build response JSONB ──
  -- S99 B5: include canonical_service_slug so callers route apply_promotion_event
  -- to the canonical slug's canonical_plan_services row (not the input alias).
  RETURN jsonb_build_object(
    'distinct_user_count', COALESCE(v_distinct_user_count, 0),
    'same_value_count', COALESCE(v_max_value_count, 0),
    'threshold', v_threshold,
    'should_promote',
      COALESCE(v_max_value_count, 0) >= v_threshold
      AND COALESCE(v_current_canonical_confidence, 0) < 0.9
      AND v_corroborated_value IS NOT NULL,
    'should_append_source',
      COALESCE(v_current_canonical_confidence, 0) >= 0.9
      AND v_corroborated_value IS NOT NULL,
    'value_matches_canonical',
      v_canonical_current_value IS NOT NULL
      AND v_corroborated_value IS NOT NULL
      AND v_canonical_current_value = v_corroborated_value,
    'corroborated_value', v_corroborated_value,
    'corroborator_excerpts', COALESCE(v_corroborator_excerpts, '[]'::jsonb),
    'current_canonical_confidence', v_current_canonical_confidence,
    'canonical_current_value', v_canonical_current_value,
    'target_table', v_target_table,
    'max_k', v_max_k,
    'canonical_service_slug', v_canonical_service_slug,
    'sibling_slugs_count', COALESCE(array_length(v_sibling_slugs, 1), 0)
  );
END;
$$;

COMMENT ON FUNCTION evaluate_pattern1_corroboration(UUID, TEXT, TEXT) IS
  'Phase 4.0.6 (Session 60) + S67 (mig 074) + S69 (mig 076) + S99 B5 (mig 108): concept_id-grouped corroboration counting. Resolves input slug to its canonical sibling via service_catalog.concept_id; counts distinct EMAIL+PHONE-verified users with cite-grade Pattern P-8 excerpts across ALL siblings sharing that concept_id; finds max-value group; returns promotion decision JSONB including canonical_service_slug for caller to route apply_promotion_event to the canonical row. Fall-through: if input slug not in catalog OR concept_id IS NULL, behaves identically to mig 076 (single-slug match). Pattern 1 #14 storage-side authority preserved.';

COMMIT;
