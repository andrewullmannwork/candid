-- =============================================================================
-- MIGRATION 074 — Email-verified gate on Pattern 1 #3 corroboration
-- =============================================================================
--
-- Adds users.email_verified column (mirror of Firebase token claim, written by
-- /api/auth/sync on every login) and modifies evaluate_pattern1_corroboration
-- to count only email-verified users toward the corroboration threshold.
--
-- WHY:
--   S67 closed the waitlist gate; signup is now public-open. The
--   evaluate_pattern1_corroboration counter was accepting any distinct
--   user_id, including unverified disposable-email accounts. Session 54 data
--   integrity audit flagged this as CRITICAL — email-only identity is
--   gameable; a single attacker with 3 disposable emails can satisfy the
--   default threshold (3 distinct users) and trigger canonical promotion of
--   poisoned plan-identity values.
--
--   Pattern 1 #15 ("identity-fraud defense at the onboarding pipeline") will
--   land structurally with S69 (Firebase phone OTP 2FA). This migration is
--   the interim layer: only email-verified accounts contribute to
--   corroboration weight. Combined with S69's phone gate, double-layered.
--
-- BACKFILL ASSUMPTION:
--   At MVP stage we have <10 production users (mostly Andrew's own testing
--   accounts, all with verified emails via Firebase). Backfilling existing
--   rows to TRUE preserves corroboration weight for legitimate users while
--   the new column begins enforcing on all future signups. /api/auth/sync
--   refreshes email_verified on every sign-in from the Firebase token claim,
--   so any drift naturally corrects on the user's next session.
--
-- ROLLBACK:
--   The function change is reverted by re-running the mig 068 function
--   definition. The column drop is forbidden per Pattern 1 #10 hard-delete
--   prohibition (deprecate via comment in a future mig if ever needed).
-- =============================================================================

-- ── 1. Add email_verified column ──────────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN users.email_verified IS
  'Mirror of Firebase email_verified token claim. Written by /api/auth/sync on every sync from decoded.email_verified. Used by evaluate_pattern1_corroboration to gate Pattern 1 #3 corroboration counting (per S67 follow-up + Session 54 audit CRITICAL finding). Pattern 1 #15 phone-verified gate lands with S69.';

-- ── 2. Backfill existing rows ─────────────────────────────────────────────────
-- MVP-stage small user count; existing accounts are mostly Andrew's testing.
-- New signups default FALSE and only flip TRUE when /api/auth/sync sees the
-- Firebase token claim email_verified=true. See WHY block above.

UPDATE users SET email_verified = TRUE WHERE email_verified = FALSE;

-- ── 3. Update evaluate_pattern1_corroboration to filter on email_verified ────
-- Both branches (plan-identity field via insurance_plans, per-service field via
-- plan_covered_services JOIN insurance_plans) JOIN users + filter
-- u.email_verified = true. Everything else identical to mig 068 v1.

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

  -- ── Branch on target user-side table ──
  IF p_service_slug IS NULL THEN
    v_target_table := 'insurance_plans';

    -- Plan-identity field corroboration: query insurance_plans directly
    -- JOIN users + filter email_verified=true (mig 074 — anti-poisoning gate)
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
    -- JOIN users + filter email_verified=true (mig 074 — anti-poisoning gate)
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
        AND sc.slug = p_service_slug
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

    SELECT
      (cps.field_provenance->p_field_name->>'confidence')::NUMERIC,
      cps.field_provenance->p_field_name->'value'
    INTO v_current_canonical_confidence, v_canonical_current_value
    FROM canonical_plan_services cps
    WHERE cps.canonical_plan_id = p_canonical_plan_id
      AND cps.service_slug = p_service_slug;
  END IF;

  -- ── Build response JSONB ──
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
    'max_k', v_max_k
  );
END;
$$;

COMMENT ON FUNCTION evaluate_pattern1_corroboration(UUID, TEXT, TEXT) IS
  'Phase 4.0.6 (Session 60) + S67 follow-up (mig 074): email-verified gate on corroboration counter. Counts distinct EMAIL-VERIFIED users with Pattern P-8 cite-grade excerpts on target user-side table; finds max-value group; returns promotion decision JSONB. JOIN users WHERE email_verified=true filters out unverified accounts so disposable-email signups can NOT contribute to canonical promotion threshold (Pattern 1 #15 + Session 54 CRITICAL audit finding). S69 phone-verified gate adds a second identity layer.';
