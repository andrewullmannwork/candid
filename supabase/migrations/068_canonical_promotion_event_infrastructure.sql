-- Migration 068: Phase 4.0.6 — Canonical promotion event infrastructure +
-- active corroboration challenge state machine
--
-- Per plans/phase_4.0.6_canonical_promotion_event.md (v4-final LOCKs Session 60).
-- Closes [[Candid_Data_Principles]] §8.1 (Pattern 1 #3 storage-side authoritative
-- confidence) + §8.2 (Active Corroboration Challenge architecture) + Pattern 1 #14
-- (canonical writes via explicit promotion event only; user-initiated data events
-- write user-scoped only).
--
-- WHY THIS MIGRATION EXISTS
--
-- Today's mig 064 RPC `upsert_canonical_services_with_merge` writes user-source
-- data into `canonical_plan_services.field_provenance` immediately on first-parse
-- at 0.5 confidence. This drifts from Pattern 1 #14 (canonical = corroborated truth,
-- by definition). Phase 4.0 (Session 57 PR #35) wired the display-layer band-aid
-- via consumer_read_filter_v1 (Pattern 1 #4 per-source thresholds). Phase 4.0.6
-- corrects the storage-layer architecture: canonical confidence promotion happens
-- ONLY via an explicit promotion event when Pattern 1 #3 corroboration threshold
-- is met (≥3 distinct users + same-value verified excerpts; configurable via
-- pattern1_corroboration_threshold flag from mig 067).
--
-- WHAT THIS MIGRATION ADDS
--
-- 1. SCHEMA — canonical_plans gains a `field_provenance` JSONB column to support
--    plan-identity-data (deductible_individual, oop_max_individual, etc.) under
--    the same provenance shape as canonical_plan_services + insurance_plans.
--    Today's typed columns on canonical_plans (deductible_individual NUMERIC, etc.)
--    remain readable as denormalized cache; field_provenance becomes the
--    authoritative confidence source for cross-user inheritance gates.
--
-- 2. SCHEMA — `canonical_promotion_events` event-sourcing log table records every
--    promotion firing for forensic audit + admin UI surfaces.
--
-- 3. SCHEMA — `canonical_correction_challenges` table (Q-P4.0.6-4 LOCK = (C) NEW
--    table; system-internal state machine separate from user-facing
--    benefit_corrections per CLAUDE.md Rule #1 "state machine ≠ entity"). Holds
--    sanity_check_passed + corroboration_count + contradiction_count + status enum
--    + admin notification log + time-decay metadata.
--
-- 4. POSTGRES FUNCTION — `evaluate_pattern1_corroboration(canonical_plan_id,
--    service_slug, field_name)` counts distinct users with verified excerpts on
--    target user-side table (insurance_plans for plan-identity fields when
--    service_slug IS NULL; plan_covered_services otherwise) and identifies the
--    max-value group. Returns JSONB describing the promotion decision.
--
-- 5. POSTGRES FUNCTION — `apply_promotion_event(canonical_plan_id, service_slug,
--    field_name, corroborated_value, sources, fire_source, actor_user_id)`
--    atomically writes promoted value at 0.9 confidence to canonical_plans /
--    canonical_plan_services field_provenance + appends top-K sources (Q-P4.0.6-3
--    LOCK v4 refinement: K=5 default; tunable via flag config) + increments
--    corroborator_count integer (unbounded count without unbounded storage) +
--    inserts canonical_promotion_events log row.
--    Holds pg_advisory_xact_lock keyed on (canonical_plan_id, service_slug,
--    field_name) per Q-P4.0.6-2 LOCK; auto-released on commit.
--
-- 6. FEATURE FLAG — `canonical_promotion_event_v1` (default OFF / global) gates
--    new behavior. When OFF: mig 064 RPC value-write branch remains active
--    (legacy behavior preserved). When ON: TS app code stops writing canonical
--    via mig 064; corroboration evaluator fires post-commit; promotion events
--    fire on threshold met. Sub-config:
--      challenge_time_decay_days: 90 (Q-P4.0.6-5 LOCK)
--      corroboration_threshold: 3 (mirrors mig 067 pattern1_corroboration_threshold)
--      cross_user_inheritance_min_confidence: 0.9 (Q-P4.0.6-7 LOCK)
--      sources_array_max_k: 5 (Q-P4.0.6-3 LOCK v4 refinement)
--
-- BACKOUT — flip flag OFF; mig 064 RPC value-write branch resumes; new tables +
-- function definitions remain (additive per CLAUDE.md Rule #7); existing
-- promotion events + challenge rows remain visible for forensics. Schema is
-- additive; no destructive operations.
--
-- ROLLOUT — apply mig to PROD; smoke-test queries; flip flag ON for admin user
-- only; 7-day soak; flip global; 7 more days; ship Task 4.0.6-I cleanup PR
-- (mig 064 RPC sunset).

BEGIN;

-- ============================================================================
-- SECTION 1: Schema additions
-- ============================================================================

-- ── 1.1: canonical_plans.field_provenance ──
-- Pattern 1 #14 + Principles §8.1: storage-side authoritative confidence for
-- plan-identity-data fields (deductible_individual, oop_max_individual,
-- premium_monthly, plan_type, metal_level, etc.). Existing typed columns remain
-- as denormalized cache; field_provenance becomes the source-of-truth for
-- cross-user inheritance gates (Q-P4.0.6-7 LOCK confidence ≥ 0.9).

ALTER TABLE canonical_plans
  ADD COLUMN IF NOT EXISTS field_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN canonical_plans.field_provenance IS
  'Phase 4.0.6 (Session 60). Pattern 1 #14 storage-side authoritative confidence for plan-identity-data fields. Per-field shape: {<field_name>: {value, source, confidence, corroborator_count, sources: [{user_id_hash, excerpt, document_ref, recorded_at} × top-K], last_corroborated_at, last_promotion_event_at, challenged_status}}. Populated ONLY via apply_promotion_event() Postgres function when Pattern 1 #3 corroboration threshold met. Existing typed columns (deductible_individual NUMERIC etc.) remain as denormalized cache; field_provenance authoritative for confidence gating.';

-- ── 1.2: canonical_plan_services.field_provenance shape extension ──
-- Existing column from mig 056. No DDL change needed; the JSONB shape extends
-- to include corroborator_count + sources array + last_promotion_event_at +
-- challenged_status post-Phase-4.0.6. Old shape readers ignore unknown keys
-- gracefully (per Pattern 1 #10 backward compat).

COMMENT ON COLUMN canonical_plan_services.field_provenance IS
  'Phase 4.0.6 (Session 60) shape extension. Per-field: {<field_name>: {value, source, confidence, corroborator_count, sources: [{user_id_hash, excerpt, document_ref, recorded_at} × top-K], last_corroborated_at, last_promotion_event_at, challenged_status}}. Pre-Phase-4.0.6 shape (DR-3B Q-DR-3B-4: source/confidence/last_corroborated_at) remains compatible; new sub-keys are additive. Populated ONLY via apply_promotion_event() Postgres function when Pattern 1 #3 corroboration threshold met (canonical_promotion_event_v1 flag ON). Pre-flag-flip behavior: mig 064 RPC writes user-source data at 0.5 confidence (legacy drift; band-aided by Phase 4.0 consumer-read filter).';

-- ── 1.3: canonical_promotion_events (event-sourcing log) ──

CREATE TABLE IF NOT EXISTS canonical_promotion_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_plan_id UUID NOT NULL REFERENCES canonical_plans(id) ON DELETE CASCADE,
  service_slug TEXT,                          -- NULL for plan-identity-level fields (canonical_plans target)
  field_name TEXT NOT NULL,                   -- e.g. 'copay', 'deductible_individual'
  event_type TEXT NOT NULL CHECK (event_type IN (
    'first_promotion',                        -- threshold met for first time; confidence 0.5/NULL → 0.9
    'corroboration_added',                    -- subsequent corroborator on already-promoted field; corroborator_count++; appends to top-K if not full
    'value_corrected_via_challenge',          -- challenge resolved corroborated; canonical value updated to corrected value
    'admin_override'                          -- admin manual intervention bypassed corroboration
  )),
  fire_source TEXT NOT NULL,                  -- 'process-plan' | 'process-eoc' | 'reparse' | 'correction-challenge-resolution' | 'admin-ui'
  corroborator_count INT NOT NULL,            -- cumulative count at fire time (post-increment)
  sources_count INT NOT NULL,                 -- count of excerpts in sources array at fire time (≤ K)
  corroborated_value JSONB NOT NULL,          -- the value written (for forensic audit trail)
  actor_user_id UUID,                         -- the user whose event triggered the promotion (nullable for admin events)
  fired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_promotion_events_canonical_field
  ON canonical_promotion_events (canonical_plan_id, service_slug, field_name);

CREATE INDEX IF NOT EXISTS idx_canonical_promotion_events_fired_at
  ON canonical_promotion_events (fired_at DESC);

COMMENT ON TABLE canonical_promotion_events IS
  'Phase 4.0.6 (Session 60). Event-sourcing log for canonical confidence promotion firings. One row per apply_promotion_event() call. Used for forensic audit (which user data corroborated this canonical field?), admin UI surfaces (recent flywheel activity), and reconciliation (cron detects missed fire events). Append-only; no UPDATE/DELETE policy. Partition by month at scale (Phase 6+).';

-- ── 1.4: canonical_correction_challenges (state machine) ──
-- Q-P4.0.6-4 LOCK = (C) NEW table — system-internal state machine; FK link to
-- benefit_corrections for user-facing correction record (separation of concerns).

CREATE TABLE IF NOT EXISTS canonical_correction_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_plan_id UUID NOT NULL REFERENCES canonical_plans(id) ON DELETE CASCADE,
  service_slug TEXT,                          -- NULL for plan-identity-level field corrections
  field_name TEXT NOT NULL,
  benefit_correction_id UUID REFERENCES benefit_corrections(id) ON DELETE SET NULL,  -- user-facing T1.8 record
  proposed_value JSONB NOT NULL,
  proposed_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Step 1 — sanity check (re-parse user's own document for the corrected field)
  sanity_check_passed BOOLEAN,                -- NULL until sanity check runs; TRUE = user's doc supports correction; FALSE = route to admin queue
  sanity_check_at TIMESTAMPTZ,
  sanity_check_notes TEXT,                    -- why sanity check passed/failed; e.g. "user OCR matches proposed value at section X"

  -- Step 2 — active corroboration challenge tracking
  corroboration_count INT NOT NULL DEFAULT 0, -- distinct users whose first-parse value matches proposed_value
  contradiction_count INT NOT NULL DEFAULT 0, -- distinct users whose first-parse value matches OLD canonical value (NOT proposed)
  status TEXT NOT NULL DEFAULT 'pending_sanity_check' CHECK (status IN (
    'pending_sanity_check',                   -- created; waiting for sanity re-parse
    'pending_corroboration',                  -- sanity passed; tracking subsequent first-parses for corroboration
    'pending_contradiction',                  -- corroboration weak; tracking contradictions
    'corroborated',                           -- ≥threshold corroborate; promotion event fired; canonical updated
    'contradicted',                           -- ≥threshold contradict; challenge dismissed; canonical retains old value
    'time_decayed',                           -- N days passed without convergence; routed to admin review
    'admin_review_requested',                 -- admin queue accepted the challenge for manual decision
    'admin_overridden',                       -- admin accepted/dismissed the challenge directly (skipped corroboration)
    'sanity_failed_admin_queue'               -- sanity check failed; routed to admin queue for manual decision
  )),

  -- Q-P4.0.6-6 LOCK v4: tiered admin notification log (Slack every event +
  -- email submission/resolution + queue persistent + Slack-failure fallback)
  admin_notification_sent_at TIMESTAMPTZ[] NOT NULL DEFAULT '{}'::TIMESTAMPTZ[],
  admin_notification_metadata JSONB NOT NULL DEFAULT '[]'::jsonb,  -- per-event: {channel, success, error_context?, retry_count?}
  notification_failure_count INT NOT NULL DEFAULT 0,

  -- Time-decay (Q-P4.0.6-5 LOCK = (B) configurable default 90 days)
  time_decay_at TIMESTAMPTZ NOT NULL,         -- created_at + INTERVAL '<challenge_time_decay_days> days' computed at insert

  -- Resolution
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT,
  admin_overridden_by UUID REFERENCES users(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for time-decay sweep + admin queries + per-canonical-field lookup
CREATE INDEX IF NOT EXISTS idx_canonical_correction_challenges_canonical_field
  ON canonical_correction_challenges (canonical_plan_id, service_slug, field_name);

CREATE INDEX IF NOT EXISTS idx_canonical_correction_challenges_status_time_decay
  ON canonical_correction_challenges (status, time_decay_at)
  WHERE status IN ('pending_corroboration', 'pending_contradiction');

CREATE INDEX IF NOT EXISTS idx_canonical_correction_challenges_proposer
  ON canonical_correction_challenges (proposed_by_user_id, created_at DESC);

COMMENT ON TABLE canonical_correction_challenges IS
  'Phase 4.0.6 (Session 60) Q-P4.0.6-4 LOCK = (C) NEW table. System-internal state machine for active corroboration challenge per Principles §8.2. Separate from benefit_corrections (user-facing T1.8 record) per CLAUDE.md Rule #1: state machine ≠ entity. FK link benefit_correction_id preserves traceability. State transitions: pending_sanity_check → (pending_corroboration | sanity_failed_admin_queue) → (corroborated | contradicted | time_decayed | admin_overridden). Per-event admin notification log (Slack + email + queue persistence) per Q-P4.0.6-6 LOCK v4 tiered. Time-decay sweep daily via QStash/pg_cron at Task 4.0.6-F.';

-- ============================================================================
-- SECTION 2: Postgres functions
-- ============================================================================

-- ── 2.1: evaluate_pattern1_corroboration ──
-- Counts distinct users with verified excerpts on target user-side table; finds
-- max-value group; returns promotion decision JSONB. Called by TS corroboration
-- evaluator post-commit per Q-P4.0.6-1 LOCK.
--
-- Polymorphic on service_slug:
--   service_slug IS NULL    → query insurance_plans (plan-identity field)
--   service_slug IS NOT NULL → query plan_covered_services JOIN insurance_plans
--
-- Returns JSONB:
--   {
--     "distinct_user_count": int,
--     "same_value_count": int,
--     "threshold": int,
--     "should_promote": bool,
--     "corroborated_value": jsonb | null,
--     "corroborator_excerpts": [{user_id_hash, excerpt, document_ref, recorded_at} × ≤K],
--     "current_canonical_confidence": numeric | null,
--     "target_table": text
--   }

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
    -- Fall back to mig 067 pattern1_corroboration_threshold flag (admin-tunable shared default)
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
    WITH user_values AS (
      -- Per user: take earliest insurance_plans row with verified excerpt for this field
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
      WHERE ip.canonical_plan_id = p_canonical_plan_id
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

    -- Read current canonical confidence + value (if field already promoted)
    SELECT
      (cp.field_provenance->p_field_name->>'confidence')::NUMERIC,
      cp.field_provenance->p_field_name->'value'
    INTO v_current_canonical_confidence, v_canonical_current_value
    FROM canonical_plans cp
    WHERE cp.id = p_canonical_plan_id;

  ELSE
    v_target_table := 'plan_covered_services';

    -- Per-service field corroboration: query plan_covered_services JOIN insurance_plans
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
      JOIN service_catalog sc ON sc.id = pcs.service_id
      WHERE ip.canonical_plan_id = p_canonical_plan_id
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
  -- TS layer evaluates the boolean flags + value-match logic to decide:
  --   * should_promote → call apply_promotion_event for first-time promotion
  --   * should_append_source AND value matches canonical → call apply_promotion_event
  --     to append new corroborator excerpt to top-K
  --   * should_append_source AND value mismatch → DON'T call apply_promotion_event;
  --     surface to active corroboration challenge state machine (Task 4.0.6-F)
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
  'Phase 4.0.6 (Session 60) Q-P4.0.6-1 LOCK v4 = (B) app-level evaluator + shared Postgres function. STABLE; pure read. Counts distinct users with verified excerpts on target user-side table (insurance_plans for service_slug IS NULL; plan_covered_services otherwise); finds max-value group; returns promotion decision JSONB including should_promote bool + should_append_source bool + corroborator_excerpts top-K (default K=5; tunable via canonical_promotion_event_v1.config.sources_array_max_k). Threshold from canonical_promotion_event_v1.config.corroboration_threshold (falls back to pattern1_corroboration_threshold.config.value; ultimate fallback 3). Called by TS corroboration evaluator (commitUploadAndEvaluateCorroboration helper) post-commit per Q-P4.0.6-1 LOCK.';

-- ── 2.2: apply_promotion_event ──
-- Atomically writes corroborated value at 0.9 confidence to canonical
-- field_provenance + appends top-K sources + increments corroborator_count +
-- inserts canonical_promotion_events log row. Holds advisory lock per
-- (canonical_plan_id, service_slug, field_name).

CREATE OR REPLACE FUNCTION apply_promotion_event(
  p_canonical_plan_id UUID,
  p_service_slug TEXT,
  p_field_name TEXT,
  p_corroborated_value JSONB,
  p_sources JSONB,                            -- array of {user_id_hash, excerpt, document_ref, recorded_at}
  p_fire_source TEXT,                         -- 'process-plan' | 'process-eoc' | 'reparse' | 'correction-challenge-resolution' | 'admin-ui'
  p_actor_user_id UUID DEFAULT NULL
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
  v_max_k INT;
  v_event_id UUID := gen_random_uuid();
  v_event_type TEXT;
  v_target_table TEXT;
  v_total_corroborator_count INT;
  v_sources_added INT;
BEGIN
  -- ── Acquire advisory lock per (canonical_plan_id, service_slug, field_name) ──
  v_lock_key := hashtextextended(
    'canonical_promotion:' || p_canonical_plan_id::TEXT || ':' || COALESCE(p_service_slug, '') || ':' || p_field_name,
    0
  );
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- ── Read max-K config ──
  SELECT (config->>'sources_array_max_k')::INT INTO v_max_k
    FROM feature_flag_rules
    WHERE flag_key = 'canonical_promotion_event_v1';
  IF v_max_k IS NULL OR v_max_k < 1 THEN
    v_max_k := 5;
  END IF;

  -- ── Determine target table ──
  IF p_service_slug IS NULL THEN
    v_target_table := 'canonical_plans';
  ELSE
    v_target_table := 'canonical_plan_services';
  END IF;

  -- ── Read existing field_provenance entry (under lock) ──
  IF v_target_table = 'canonical_plans' THEN
    SELECT field_provenance INTO v_existing_provenance
    FROM canonical_plans
    WHERE id = p_canonical_plan_id;
  ELSE
    SELECT field_provenance INTO v_existing_provenance
    FROM canonical_plan_services
    WHERE canonical_plan_id = p_canonical_plan_id AND service_slug = p_service_slug;
  END IF;

  v_existing_provenance := COALESCE(v_existing_provenance, '{}'::jsonb);
  v_existing_field_entry := v_existing_provenance->p_field_name;
  v_current_confidence := (v_existing_field_entry->>'confidence')::NUMERIC;
  v_current_corroborator_count := COALESCE((v_existing_field_entry->>'corroborator_count')::INT, 0);
  v_existing_sources := COALESCE(v_existing_field_entry->'sources', '[]'::jsonb);

  -- ── Determine event type ──
  -- Race-aware: if another concurrent writer already promoted while we waited
  -- for the lock, this becomes a corroboration_added event instead of first_promotion.
  IF COALESCE(v_current_confidence, 0) < 0.9 THEN
    v_event_type := 'first_promotion';
  ELSE
    v_event_type := 'corroboration_added';
  END IF;

  -- ── Compute total corroborator count (existing + new sources, deduped by user_id_hash) ──
  -- Same-user repeat-action doesn't inflate count (mig 066 NOT EXISTS guard pattern at
  -- canonical-row level; here at field level via user_id_hash dedup).
  WITH all_hashes AS (
    SELECT DISTINCT (entry->>'user_id_hash') AS h
    FROM jsonb_array_elements(v_existing_sources || COALESCE(p_sources, '[]'::jsonb)) AS entries(entry)
  )
  SELECT COUNT(*) INTO v_total_corroborator_count FROM all_hashes;

  -- ── Build merged sources array (top-K; first-K-arrived) ──
  -- Strategy: union existing + new sources, dedupe by user_id_hash, sort by recorded_at,
  -- truncate to v_max_k. New sources beyond K increment counter but don't add to array.
  WITH unioned AS (
    SELECT DISTINCT ON (entry->>'user_id_hash')
      entry
    FROM jsonb_array_elements(v_existing_sources || COALESCE(p_sources, '[]'::jsonb)) AS entries(entry)
    ORDER BY entry->>'user_id_hash', entry->>'recorded_at'
  )
  SELECT COALESCE(jsonb_agg(entry ORDER BY entry->>'recorded_at'), '[]'::jsonb)
  INTO v_merged_sources
  FROM (
    SELECT entry FROM unioned ORDER BY entry->>'recorded_at' LIMIT v_max_k
  ) limited;

  v_sources_added := jsonb_array_length(v_merged_sources);

  -- ── Build new field_provenance entry ──
  v_new_field_entry := jsonb_build_object(
    'value', p_corroborated_value,
    'source', 'multi_source_corroboration',
    'confidence', 0.9,
    'corroborator_count', v_total_corroborator_count,
    'sources', v_merged_sources,
    'last_corroborated_at', now(),
    'last_promotion_event_at', now(),
    'challenged_status', 'none'
  );

  -- ── Atomic write to canonical field_provenance ──
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
      'multi_source_corroboration',
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
        source = 'multi_source_corroboration',
        updated_at = now();
  END IF;

  -- ── Insert event log row ──
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

COMMENT ON FUNCTION apply_promotion_event(UUID, TEXT, TEXT, JSONB, JSONB, TEXT, UUID) IS
  'Phase 4.0.6 (Session 60) Q-P4.0.6-2 LOCK = (A) advisory lock per (canonical_plan_id, service_slug, field_name) + Q-P4.0.6-3 LOCK v4 = (A) JSONB inline + top-K bound. Atomic: writes promoted value at 0.9 confidence to canonical field_provenance + appends top-K sources (deduped by user_id_hash; default K=5 from canonical_promotion_event_v1.config.sources_array_max_k) + increments corroborator_count integer (unbounded) + inserts canonical_promotion_events log row. Race-aware: if concurrent writer beat us to first_promotion, event_type becomes corroboration_added. service_slug IS NULL targets canonical_plans; otherwise canonical_plan_services. Called by TS promotion event mechanism (Task 4.0.6-E) when evaluate_pattern1_corroboration returns should_promote OR should_append_source.';

GRANT EXECUTE ON FUNCTION evaluate_pattern1_corroboration(UUID, TEXT, TEXT)
  TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION apply_promotion_event(UUID, TEXT, TEXT, JSONB, JSONB, TEXT, UUID)
  TO service_role;
-- NOTE: apply_promotion_event NOT granted to authenticated. Only service_role
-- (server-side TS code via supabase admin client) can fire promotion events.
-- Pattern 1 #14 enforcement at function-grant layer.

-- ============================================================================
-- SECTION 3: Feature flag seed
-- ============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'canonical_promotion_event_v1',
  false,
  'Phase 4.0.6 (Session 60). Gates the canonical promotion event mechanism (Pattern 1 #14 storage-layer correction). When OFF (default): mig 064 RPC value-write branch active (legacy first-parse writes user-source data to canonical_plan_services at 0.5 confidence; band-aided by Phase 4.0 consumer-read filter Pattern 1 #4 enforcement). When ON: TS app code stops writing canonical via mig 064; commitUploadAndEvaluateCorroboration helper fires post-commit; promotion events fire on threshold met. Sub-config: challenge_time_decay_days (default 90; Q-P4.0.6-5), corroboration_threshold (default 3; mirrors mig 067 pattern1_corroboration_threshold; Q-P4.0.6-1), cross_user_inheritance_min_confidence (default 0.9; Q-P4.0.6-7), sources_array_max_k (default 5; Q-P4.0.6-3 v4 storage bound). Rollout: admin-only soak 7 days → global flip → 7 days soak → Task 4.0.6-I cleanup PR (mig 064 RPC sunset).',
  'global',
  jsonb_build_object(
    'challenge_time_decay_days', 90,
    'corroboration_threshold', 3,
    'cross_user_inheritance_min_confidence', 0.9,
    'sources_array_max_k', 5
  )
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
