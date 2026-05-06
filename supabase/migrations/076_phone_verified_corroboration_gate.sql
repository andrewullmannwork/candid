-- =============================================================================
-- MIGRATION 076 — Phone-verified gate on Pattern 1 #3 corroboration (S69)
-- =============================================================================
--
-- Adds users.phone_e164 + users.phone_verified columns (mirror of Firebase
-- token claim, written by /api/auth/sync on every login when decoded.phone_number
-- is present), seeds the phone_otp_enforcement_v1 feature flag, and modifies
-- evaluate_pattern1_corroboration to require BOTH email_verified AND
-- phone_verified before counting a user toward the corroboration threshold.
--
-- WHY:
--   S67 closed the waitlist gate (signup is public-open). S68 added Cloudflare
--   Turnstile bot defense. Mig 074 added the email-verified gate as an interim
--   defense per Session 54 audit CRITICAL finding (disposable-email accounts
--   could otherwise satisfy Pattern 1 #3 corroboration threshold and poison
--   canonical plan-identity values).
--
--   Phone OTP is the structural identity layer per Pattern 1 #15 ("identity-
--   fraud defense at the onboarding pipeline"). US phone numbers cost
--   ~$0.10–$5 per disposable phone vs effectively free for disposable email,
--   so phone-OTP requirement materially raises the cost of a fake account.
--   Combined with mig 074 email gate + S68 Turnstile, the cost of a single
--   fake account approaches manual labor.
--
-- BACKFILL POLICY (Q-S69-3 LOCK — Session 69 user direction):
--   NO grandfather. Existing users start phone_verified=FALSE. Diverges from
--   mig 074's grandfather backfill — phone is the structural layer per
--   Pattern 1 #15, deserves stricter enforcement. Existing accounts (mostly
--   Andrew's testing) can sign in (no signup-only gate per Q-S69-5) but do
--   NOT contribute to corroboration until they add phone via re-signup or
--   Phase 2 self-serve "verify your phone" flow.
--
--   Implication: post-flag-flip, evaluate_pattern1_corroboration returns 0
--   distinct users until first phone-verified signup completes. Acceptable
--   at MVP cold-start; threshold of 3 distinct users wasn't being met
--   anyway with <10 testing users.
--
-- ROLLBACK:
--   The function change reverts by re-running mig 074's function definition
--   (drops the phone_verified filter, leaving email_verified-only filter).
--   Column drop is forbidden per Pattern 1 #10 hard-delete prohibition; if
--   ever needed, deprecate via comment in a future migration.
--   Application-layer rollback: flip phone_otp_enforcement_v1 flag OFF —
--   server stops gating /api/auth/sync on decoded.phone_number presence.
-- =============================================================================

-- ── 1. Add phone_e164 + phone_verified columns to users ───────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone_e164 TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN users.phone_e164 IS
  'E.164-formatted phone number (+1<10digits> for US; only US supported in v1 per Q-S69-2). Mirror of Firebase decoded.phone_number token claim, written by /api/auth/sync on every sync. Auth-grade (not display): paired with phone_verified for Pattern 1 #15 identity defense. Distinct from profiles.phone (free-form display).';

COMMENT ON COLUMN users.phone_verified IS
  'Mirror of Firebase decoded.phone_number presence. TRUE iff Firebase user has a linked phone via signInWithPhoneNumber/linkWithPhoneNumber OTP confirmation. Used by evaluate_pattern1_corroboration to gate Pattern 1 #3 corroboration counting (S69 — Pattern 1 #15 structural identity layer; layered with mig 074 email_verified for defense in depth). NO grandfather backfill (Q-S69-3 LOCK Session 69) — existing users must add phone to contribute.';

-- ── 2. NO grandfather backfill ───────────────────────────────────────────────
-- Per Q-S69-3 user direction Session 69: existing users start phone_verified=FALSE.
-- Column default FALSE applies. Empty SQL block — explicit no-op for clarity.
-- (Compare with mig 074 line 50 which DID grandfather email_verified=TRUE.)

-- ── 3. Seed phone_otp_enforcement_v1 feature flag ────────────────────────────
-- Default OFF per Q-S69-9. Application code reads this flag in /api/auth/sync
-- and only enforces the phone_number presence check on userAction='signup'.
-- Flip ON post-deploy + Vercel build verification + Firebase Phone Auth flow
-- smoke (matches S68 turnstile_enforcement_v1 rollout pattern).

INSERT INTO feature_flag_rules (flag_key, scope, enabled, value, config)
VALUES (
  'phone_otp_enforcement_v1',
  'global',
  FALSE,
  NULL,
  '{"description": "S69 Firebase Phone OTP at signup. When enabled, /api/auth/sync rejects userAction=signup requests where decoded.phone_number is null with 403. Mirrors decoded.phone_number to users.phone_e164 + sets phone_verified=true on every sync regardless of flag (so flipping flag ON enforces gate without re-syncing existing sessions). Combined with email_verified in evaluate_pattern1_corroboration AND filter for Pattern 1 #15 + mig 074 layered identity defense."}'::JSONB
)
ON CONFLICT (flag_key, scope, value) DO NOTHING;

-- ── 4. Update evaluate_pattern1_corroboration with phone_verified AND filter ─
-- Both branches (plan-identity field via insurance_plans, per-service field via
-- plan_covered_services JOIN insurance_plans) JOIN users + filter
-- u.email_verified=TRUE AND u.phone_verified=TRUE. Everything else identical
-- to mig 074. Comment updated to reflect double-layer identity defense.

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
    -- JOIN users + filter email_verified=TRUE AND phone_verified=TRUE
    -- (mig 074 + mig 076 — layered identity defense per Pattern 1 #15)
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
    -- (mig 074 + mig 076 — layered identity defense per Pattern 1 #15)
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
  'Phase 4.0.6 (Session 60) + S67 follow-up (mig 074) + S69 (mig 076): layered email-verified AND phone-verified gate on corroboration counter. Counts distinct EMAIL+PHONE-verified users with Pattern P-8 cite-grade excerpts on target user-side table; finds max-value group; returns promotion decision JSONB. JOIN users WHERE email_verified=TRUE AND phone_verified=TRUE filters out (a) unverified disposable-email accounts AND (b) non-phone-verified accounts so disposable-email + disposable-or-no-phone signups can NOT contribute to canonical promotion threshold (Pattern 1 #15 structural identity defense + Session 54 CRITICAL audit finding). Per Q-S69-3 NO grandfather: legacy users (phone_verified=FALSE by default) excluded until they add phone.';
