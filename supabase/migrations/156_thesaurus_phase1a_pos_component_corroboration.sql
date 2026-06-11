-- =============================================================================
-- MIGRATION 156 — Service Thesaurus Phase 1a: pos/component-aware corroboration
--                 (schema + evaluator + flag seed)
-- =============================================================================
-- SoT: plans/service_thesaurus_phase1a.md (DESIGN APPROVED S172) · §3.2 + §4.
-- Grounded against PROD `8d1daea` (S172). Tracker: pre_launch_backend_hardening §3 Thesaurus.
--
-- APPLY-SAFETY: ADDITIVE ONLY (Rule #7). Safe to apply EARLY (Studio) ahead of the
-- Phase-1a code, because:
--   • the `component` column is a new NOT NULL DEFAULT 'global' column (existing rows
--     take 'global'; no collision);
--   • the evaluator is byte-identical for the live 3-arg caller (see "OFF = byte-identical");
--   • the flag seeds OFF.
-- The `plan_covered_services` UNIQUE re-key (3-col → 4-col) is DELIBERATELY NOT here —
--   it is a BREAKING change for the two existing 3-col `onConflict` upserts
--   (src/lib/plan/process-plan.ts:1513 + src/lib/claims/backflow.ts:52) and ships in
--   mig 157, applied IN LOCKSTEP with the T4 write-path code. Keeping apply-safety
--   uniform (additive→early, breaking→with-code) avoids a broken-but-inert window.
--
-- WHAT CHANGES:
--   PART A — add `plan_covered_services.component` (mirrors mig 147's canonical CHECK).
--   PART B — CREATE OR REPLACE `evaluate_pattern1_corroboration` with two NEW
--            NULL-conditional params (`p_place_of_service`, `p_component`) so per-service
--            corroboration can group on the (concept-siblings × place_of_service × component)
--            cost-share CELL — while preserving the mig-108 concept_id grouping and leaving
--            the plan-identity branch byte-identical.
--   PART C — seed feature flag `thesaurus_phase1a_v1` (OFF/global; mirrors mig 075 shape).
--
-- OFF = BYTE-IDENTICAL (provable):
--   The live caller (src/lib/parser/corroboration-evaluator.ts → commit-and-evaluate.ts:412)
--   passes the 3 original args only. Both new params default to NULL, so each predicate
--   `(p_x IS NULL OR col = p_x)` collapses to TRUE → counting is identical to mig 108
--   (aggregate across pos/component). pos/component values are PASSED only by the T4 caller
--   when `thesaurus_phase1a_v1` is ON (flag-gating lives in TS, consistent with §3.1/§3.3).
--   Pre-launch the per-service branch is inert anyway (no verified users → user_values empty).
--
-- BONUS (ON-path only): mig-108's canonical-current-value read (`… AND service_slug = …`,
--   no pos/component) became MULTI-ROW after mig 147/148 split canonical rows into
--   facility/professional (e.g. hospital_admission → 2 rows). Today its `SELECT … INTO`
--   silently takes an arbitrary row (latent, inert — no users). When pos/component are
--   passed (ON), the new predicate pins it to the single 4-col-unique row. The OFF/NULL
--   path preserves the (inert) old behavior, so "OFF = byte-identical" still holds.
--
-- ROLLBACK (after any code referencing the new column/params reverts):
--   DROP FUNCTION IF EXISTS evaluate_pattern1_corroboration(UUID, TEXT, TEXT, TEXT, TEXT);
--   -- then re-run mig 108's 3-arg CREATE OR REPLACE body to restore the prior evaluator;
--   ALTER TABLE plan_covered_services DROP COLUMN IF EXISTS component;
--   UPDATE feature_flag_rules SET enabled = false WHERE flag_key = 'thesaurus_phase1a_v1';
--   --   (flag ROW kept per Pattern 1 #10 hard-delete prohibition — flip OFF, do not DELETE.)
-- =============================================================================

BEGIN;

-- ── PART A — plan_covered_services.component (additive; mirrors mig 147) ──────
ALTER TABLE plan_covered_services
  ADD COLUMN IF NOT EXISTS component TEXT NOT NULL DEFAULT 'global'
    CHECK (component IN ('facility','professional','global'));   -- billing-grounded; "professional" not "physician"

-- ── PART B — pos/component-aware corroboration evaluator ─────────────────────
-- Adding defaulted params creates a DISTINCT overload (3-arg vs 5-arg) → PostgREST
-- ambiguity on the 3-named-arg call. DROP the old signature first, then CREATE the
-- 5-arg version (same idiom mig 148 used for apply_promotion_event).
DROP FUNCTION IF EXISTS evaluate_pattern1_corroboration(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION evaluate_pattern1_corroboration(
  p_canonical_plan_id UUID,
  p_service_slug TEXT,
  p_field_name TEXT,
  p_place_of_service TEXT DEFAULT NULL,   -- mig 156: NULL = aggregate (byte-identical mig 108)
  p_component TEXT DEFAULT NULL            -- mig 156: NULL = aggregate (byte-identical mig 108)
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
  -- ── Read tunable config from feature flag ── (unchanged from mig 108)
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

  -- ── S99 B5: resolve input slug to canonical + sibling slugs ── (unchanged from mig 108)
  -- For plan-identity fields (p_service_slug IS NULL) this is skipped; the plan-identity
  -- branch below runs unchanged. Fall-through (slug not in catalog OR concept_id IS NULL):
  -- treat the input slug as its own canonical with one sibling = itself (mig 076 behavior).
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

    IF v_canonical_service_slug IS NULL THEN
      v_canonical_service_slug := p_service_slug;
      v_sibling_slugs := ARRAY[p_service_slug];
    END IF;
  END IF;

  -- ── Branch on target user-side table ──
  IF p_service_slug IS NULL THEN
    v_target_table := 'insurance_plans';

    -- Plan-identity field corroboration — UNCHANGED from mig 108 (pos/component do not
    -- apply to plan-identity fields; this branch never reads them).
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
    -- JOIN users + email/phone-verified. S99 B5: WHERE sc.slug = ANY(v_sibling_slugs)
    -- (concept_id-grouped). mig 156: ALSO group on the (place_of_service, component)
    -- cost-share CELL via NULL-conditional predicates — NULL = aggregate (mig 108).
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
        -- mig 156: pos/component cell grouping (NULL = don't filter = byte-identical mig 108)
        AND (p_place_of_service IS NULL OR pcs.place_of_service = p_place_of_service)
        AND (p_component IS NULL OR pcs.component = p_component)
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

    -- S99 B5: read canonical_plan_services by canonical sibling slug, not the input slug.
    -- mig 156: NULL-conditional pos/component pins the read to the single 4-col-unique
    -- row on the ON-path (fixes the latent post-148 multi-row read); NULL preserves the
    -- (inert) mig-108 first-arbitrary-row behavior → byte-identical OFF.
    SELECT
      (cps.field_provenance->p_field_name->>'confidence')::NUMERIC,
      cps.field_provenance->p_field_name->'value'
    INTO v_current_canonical_confidence, v_canonical_current_value
    FROM canonical_plan_services cps
    WHERE cps.canonical_plan_id = p_canonical_plan_id
      AND cps.service_slug = v_canonical_service_slug
      AND (p_place_of_service IS NULL OR cps.place_of_service = p_place_of_service)
      AND (p_component IS NULL OR cps.component = p_component);
  END IF;

  -- ── Build response JSONB ── (mig 108 keys; mig 156 echoes pos/component additively) ──
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
    'sibling_slugs_count', COALESCE(array_length(v_sibling_slugs, 1), 0),
    'place_of_service', p_place_of_service,
    'component', p_component
  );
END;
$$;

COMMENT ON FUNCTION evaluate_pattern1_corroboration(UUID, TEXT, TEXT, TEXT, TEXT) IS
  'Phase 4.0.6 + S67 (mig 074) + S69 (mig 076) + S99 B5 (mig 108) + S173 Thesaurus Phase 1a (mig 156): concept_id-grouped corroboration counting, NOW also cell-grouped on (place_of_service, component) via two NULL-conditional params. NULL pos/component = aggregate (byte-identical mig 108; the live 3-arg caller path). Non-NULL = restrict the per-service user-row count AND the canonical-current-value read to that cost-share cell (also pins the otherwise-multi-row post-148 canonical read to one 4-col-unique row). Plan-identity branch (p_service_slug IS NULL) unchanged. Flag-gating (thesaurus_phase1a_v1) lives in the TS caller, which passes pos/component only when ON. The plan_covered_services UNIQUE re-key (3→4-col) ships in mig 157 with the T4 write-path. Pattern 1 #14 storage-side authority preserved.';

-- ── PART B2 — re-establish the explicit grant the DROP discarded (mirrors mig 068:650) ──
-- The signature change forces DROP+CREATE (CREATE OR REPLACE cannot add params), and DROP
-- discards the grant that mig 074/076/108 kept alive through CREATE OR REPLACE. Re-issue it
-- on the 5-arg signature so a later REVOKE-FROM-PUBLIC hardening pass cannot strip the live
-- caller's EXECUTE access. (Today PUBLIC has default EXECUTE, so this is intent-preserving,
-- not a behavior change.)
GRANT EXECUTE ON FUNCTION evaluate_pattern1_corroboration(UUID, TEXT, TEXT, TEXT, TEXT)
  TO authenticated, service_role;

-- ── PART C — flag seed thesaurus_phase1a_v1 (OFF/global; mirrors mig 075 shape) ──
INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'thesaurus_phase1a_v1',
  false,
  'S173 Service Thesaurus Phase 1a. Master gate for: (1) plan-doc resolver routing — post-extraction rawLabel→slug via resolveServices, cache-first (§3.1); (2) corroboration-gated cross-user cache writeback — a single uncorroborated Haiku does NOT teach billing_code_mappings (§3.3); (3) pos/component-aware corroboration READ — the TS caller passes place_of_service+component to evaluate_pattern1_corroboration only when this flag is ON (§3.2). OFF = byte-identical to pre-Phase-1a PROD. Read in TS at render/parse time (not in SQL). Thresholds/allowlists carried in config JSONB (G6, code-default-overlaid — empty seed = no mig-vs-code drift). Exposure of synonym-inferred coverage to users is HELD for Phase 2 ∥ Phase 6 (cite-grade) even when ON.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
