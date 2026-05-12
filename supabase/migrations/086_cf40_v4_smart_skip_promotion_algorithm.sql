-- =============================================================================
-- MIGRATION 086 — CF-40 v4 Smart-Skip + Per-Doc-Type Promotion Algorithm (S73.5)
-- =============================================================================
--
-- WHY (Subplan [[plans/s73.5_cf40_refine]] §1 + Pattern 1 #16 in
-- [[Candid_Data_Patterns]]):
--   CF-40 v3 (mig 080+081+082) introduced per-(canonical, file_hash) stability
--   tracking with multi-slot candidates + outlier-elimination eviction. Session
--   79 critical multi-turn review surfaced 8 architectural gaps in v3 (single-
--   level promotion too coarse; no anti-AI-fraud at scale; no drift detection
--   on stable hashes; flat 3-parse threshold doesn't scale; no temporal-
--   distribution requirement; no "complete extraction" criterion; no challenger
--   formation mechanism; no admin cold-start lever).
--
--   v4 closes all eight via a 5-layer scale-aware algorithm:
--     Layer 1 — Validity gates (self-check ≥ 0.95, OCR/classification, plan-
--               year-aware doc-age, file size, identity, not banned)
--     Layer 2 — Trust-weighted + time-decayed stability counter (admin=3.0,
--               phone+email=1.0, phone-only=0.6, email-only=0.5)
--     Layer 3 — Per-(canonical, doc_type) 3-criteria promotion (corroboration,
--               supermajority share, coverage completeness)
--     Layer 4 — Slow-drift + rapid-change + verification mode invalidation
--     Layer 5 — Forced re-parse sampling (admin always; statistical 25%/5%/2%/
--               0.5%; temporal staleness; admin-attestation validation;
--               verification mode; every 5th smart-skip on stable hash)
--
--   Plus plan-year-aware document routing (REPLACES absolute 12-month gate),
--   4-tier badging vocabulary, backend-confidence decouple from visible badge,
--   admin attestation as MVP cold-start lever, and Pattern 1 #14 compliance
--   via dedicated `canonical_invalidation_events` audit table.
--
-- WHAT THIS MIGRATION ADDS:
--   1. NEW canonical_doctype_promotion_state — per-(canonical, doc_type)
--      promotion state machine (Layer 3 output).
--   2. NEW canonical_field_corroboration — materialized corroboration metrics
--      for dispute-letter cite-grade decisions (Q-S73.5-35 Option C).
--   3. NEW canonical_invalidation_events — audit log for canonical maintenance
--      writes (Pattern 1 #14 compliance via explicit event log).
--   4. NEW canonical_drift_events — slow-drift telemetry.
--   5. NEW canonical_divergence_review — admin queue for minority candidates.
--   6. ALTER canonical_plans — divergence_pending_verification BOOLEAN (Layer 4(c)
--      canonical-wide flag).
--   7. ALTER canonical_document_stability — parse_weight_accumulated (Layer 2),
--      smart_skip_count (Layer 5 every-5th gate), last_full_parse_at (Layer 5
--      temporal staleness).
--   8. ALTER insurance_plans — historical_only BOOLEAN (Subplan §2.10 plan-year-
--      aware routing for outside-window docs).
--   9. AFTER INSERT trigger on canonical_haiku_extractions to maintain
--      canonical_field_corroboration counters.
--  10. Feature flag seeds: cf40_v4_algorithm (default OFF) + admin_attestation_
--      enabled (default ON for MVP cold-start per Q-S73.5-16 LOCK).
--
-- DEPENDENCIES:
--   - canonical_plans (mig 020 + later)
--   - canonical_document_stability (mig 081 + 082)
--   - canonical_haiku_extractions (mig 084)
--   - feature_flag_rules (mig 075 shape)
--   - users (mig 001) — for admin_user_id FKs
--
-- BACKOUT:
--   Application-layer rollback: keep cf40_v4_algorithm flag OFF — v3 behavior
--   is preserved as the no-flag fallback path. Schema is additive only; no
--   columns dropped, no constraints removed.
--
-- PILLAR: P2 (cross-service data flow — primary) + P1 (document ingestion) + P3
-- (UX/UI badging) + P4 (schema/security via Pattern 1 #14 audit).
-- =============================================================================

BEGIN;

-- ── 1. canonical_doctype_promotion_state (Layer 3 output) ────────────────────

CREATE TABLE IF NOT EXISTS canonical_doctype_promotion_state (
  canonical_plan_id UUID NOT NULL REFERENCES canonical_plans(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL
    CHECK (document_type IN ('sbc', 'eoc', 'plan_document', 'education_doc')),
  doctype_promoted BOOLEAN NOT NULL DEFAULT FALSE,
  promotion_event_type TEXT
    CHECK (promotion_event_type IN ('pattern1_3_organic', 'admin_attested')),
  promoted_at TIMESTAMPTZ,
  re_baseline_required BOOLEAN NOT NULL DEFAULT FALSE,
  -- Cached coverage score (Layer 3(c)). Denormalized for read perf; recomputed
  -- on each parse-event evaluation. Bounded [0, 1].
  coverage_score NUMERIC(4,3),
  distinct_users_count INT NOT NULL DEFAULT 0,
  total_qualifying_uploads INT NOT NULL DEFAULT 0,
  last_evaluated_at TIMESTAMPTZ,
  PRIMARY KEY (canonical_plan_id, document_type)
);

CREATE INDEX IF NOT EXISTS idx_canonical_doctype_promotion_promoted
  ON canonical_doctype_promotion_state (canonical_plan_id, doctype_promoted)
  WHERE doctype_promoted = TRUE;

COMMENT ON TABLE canonical_doctype_promotion_state IS
  'S73.5 (Session 80). Per-(canonical, doc_type) Layer 3 promotion state. doctype_promoted=TRUE when (corroboration ≥ N(scale)) + (supermajority over time-decayed weights) + (coverage_score ≥ threshold) ALL pass for this doc-type. Canonical-level Verified rule (Subplan §2.5): canonical_verified = sbc_promoted AND (eoc_promoted OR plan_document_promoted). education_doc is bonus only (does not gate). Maintained by parse-event hook in src/lib/parser/cf40-v4/.';

COMMENT ON COLUMN canonical_doctype_promotion_state.promotion_event_type IS
  'pattern1_3_organic: Layer 3 (a)+(b)+(c) all met organically. admin_attested: bypassed 3(a)+(b) via admin attestation (Layer 3(c) coverage still required; ≥2 admin uploads per doc-type per Q-S73.5-21 LOCK). Audit trail.';

COMMENT ON COLUMN canonical_doctype_promotion_state.coverage_score IS
  'Layer 3(c): 0.5 * plan_identity_coverage + 0.5 * service_coverage. See src/lib/parser/doctype-expected-counts.ts. Thresholds: SBC=0.80, EOC=0.75, plan_document=0.65, education_doc=0.60.';

COMMENT ON COLUMN canonical_doctype_promotion_state.re_baseline_required IS
  'Set TRUE by Layer 4 (slow-drift or rapid-change invalidation). Forces re-evaluation; clears doctype_promoted. Resets to FALSE when new stability + promotion criteria met.';

-- ── 2. canonical_field_corroboration (Q-S73.5-35 Option C materialized) ──────

CREATE TABLE IF NOT EXISTS canonical_field_corroboration (
  canonical_plan_id UUID NOT NULL REFERENCES canonical_plans(id) ON DELETE CASCADE,
  service_slug TEXT,
  field_name TEXT NOT NULL,
  -- SHA-256 of canonicalized JSONB value (stable key — same value → same hash).
  extracted_value_hash TEXT NOT NULL,
  extracted_value_jsonb JSONB NOT NULL,
  distinct_user_count INT NOT NULL DEFAULT 0,
  distinct_document_count INT NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- COALESCE wraps NULL service_slug for plan-identity-level fields so PK is
  -- unique across the (canonical, '', field_name) plan-identity tuple.
  PRIMARY KEY (canonical_plan_id, COALESCE(service_slug, ''), field_name, extracted_value_hash)
);

CREATE INDEX IF NOT EXISTS idx_canonical_field_corroboration_lookup
  ON canonical_field_corroboration (canonical_plan_id, service_slug, field_name);

COMMENT ON TABLE canonical_field_corroboration IS
  'S73.5 (Session 80) Q-S73.5-35 LOCK Option C. Materialized corroboration metrics for fast dispute-letter cite-grade decisions. Maintained via AFTER INSERT trigger on canonical_haiku_extractions. Replaces on-demand aggregate queries (would not scale; ~500ms+ per query at 1M parses). For Provisional fields, dispute letter checks distinct_user_count + distinct_document_count to decide blockquote vs hide (see getDisputeLetterTreatment in src/lib/parser/cf40-v4/dispute-treatment.ts). Backfill on first deploy: see scripts/backfill-canonical-field-corroboration.ts.';

COMMENT ON COLUMN canonical_field_corroboration.extracted_value_hash IS
  'SHA-256 hex digest of canonicalized JSONB value. Same logical value → same hash even across separate user uploads. Trigger maintains uniqueness by including this in the primary key.';

-- ── 3. canonical_invalidation_events (Pattern 1 #14 audit log) ───────────────

CREATE TABLE IF NOT EXISTS canonical_invalidation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_plan_id UUID NOT NULL REFERENCES canonical_plans(id) ON DELETE CASCADE,
  -- NULL when the event is canonical-wide (e.g., verification mode toggle).
  document_type TEXT
    CHECK (document_type IS NULL OR document_type IN ('sbc', 'eoc', 'plan_document', 'education_doc')),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'slow_drift_invalidation',
    'rapid_change_invalidation',
    'rapid_change_pending_admin_review',
    'admin_manual_invalidation',
    'verification_mode_triggered',
    'verification_mode_resolved_noise',
    'verification_mode_resolved_drift'
  )),
  triggering_user_ids UUID[],
  divergent_value_jsonb JSONB,
  baseline_value_jsonb JSONB,
  admin_disposition TEXT
    CHECK (admin_disposition IN ('pending', 'confirmed', 'rejected', 'deferred')),
  admin_disposition_at TIMESTAMPTZ,
  admin_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_invalidation_events_canonical
  ON canonical_invalidation_events (canonical_plan_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_invalidation_events_pending
  ON canonical_invalidation_events (event_type, created_at DESC)
  WHERE admin_disposition = 'pending' OR admin_disposition IS NULL;

COMMENT ON TABLE canonical_invalidation_events IS
  'S73.5 (Session 80). Audit log for canonical-side maintenance writes (Pattern 1 #14 compliance via explicit event log; not silent parser-side maintenance). All Layer 4 events (slow-drift + rapid-change + admin manual + verification mode transitions) write a row here. Admin UI at /admin/canonical-quality reads pending events.';

-- ── 4. canonical_drift_events (slow-drift telemetry) ─────────────────────────

CREATE TABLE IF NOT EXISTS canonical_drift_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_plan_id UUID NOT NULL REFERENCES canonical_plans(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL
    CHECK (document_type IN ('sbc', 'eoc', 'plan_document', 'education_doc')),
  divergence_rate_30d NUMERIC(4,3),
  divergent_user_count_30d INT,
  triggered_re_baseline BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_drift_events_canonical
  ON canonical_drift_events (canonical_plan_id, created_at DESC);

COMMENT ON TABLE canonical_drift_events IS
  'S73.5 (Session 80). Slow-drift detection telemetry. Layer 4(a) rule: divergence_rate_30d > 0.3 AND divergent_user_count_30d ≥ 3 → re_baseline_required[doc_type] = TRUE. Row written on every evaluation regardless of trigger (diagnostic; triggered_re_baseline flag distinguishes).';

-- ── 5. canonical_divergence_review (admin queue for minority candidates) ─────

CREATE TABLE IF NOT EXISTS canonical_divergence_review (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_plan_id UUID NOT NULL REFERENCES canonical_plans(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL
    CHECK (document_type IN ('sbc', 'eoc', 'plan_document', 'education_doc')),
  field_name TEXT NOT NULL,
  minority_value_jsonb JSONB NOT NULL,
  minority_weight NUMERIC(6,3) NOT NULL,
  total_weight NUMERIC(6,3) NOT NULL,
  -- Generated columns can't reference NULLIF on a non-stored input in older
  -- Postgres, so compute in application or via index; here we provide as a
  -- stored generated column with CASE for divide-by-zero safety.
  minority_share NUMERIC(4,3) GENERATED ALWAYS AS (
    CASE WHEN total_weight > 0 THEN minority_weight / total_weight ELSE 0 END
  ) STORED,
  contributing_user_ids UUID[],
  divergence_type TEXT NOT NULL CHECK (divergence_type IN (
    'possible_plan_variant',
    'possible_adversarial',
    'possible_stale_doc',
    'possible_haiku_noise',
    'unclassified'
  )),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'rejected', 'deferred')),
  admin_user_id UUID REFERENCES users(id),
  admin_disposition_at TIMESTAMPTZ,
  admin_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_divergence_review_pending
  ON canonical_divergence_review (status, created_at DESC)
  WHERE status = 'pending';

COMMENT ON TABLE canonical_divergence_review IS
  'S73.5 (Session 80). Admin queue for minority candidates from Layer 3(b) majority-share evaluation. v3 outlier-elimination silently dropped minority candidates; v4 routes them here for admin disambiguation (could be legitimate plan amendments OR adversarial uploads OR stale docs OR Haiku noise — admin decides). Admin UI at /admin/canonical-quality reads pending rows.';

-- ── 6. ALTER canonical_plans — verification-mode flag ────────────────────────

ALTER TABLE canonical_plans
  ADD COLUMN IF NOT EXISTS divergence_pending_verification BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN canonical_plans.divergence_pending_verification IS
  'S73.5 (Session 80) Layer 4(c) verification mode. TRUE when a forced re-parse diverged from baseline; next upload of ANY doc-type on this canonical is forced to full-parse (NOT smart-skip) to confirm/deny divergence. Canonical-wide flag (NOT per-doc-type) for fastest divergence confirmation per Q-S73.5-39 LOCK.';

-- ── 7. ALTER canonical_document_stability — v4 weight accumulation ───────────

ALTER TABLE canonical_document_stability
  ADD COLUMN IF NOT EXISTS parse_weight_accumulated NUMERIC(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS smart_skip_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_full_parse_at TIMESTAMPTZ;

COMMENT ON COLUMN canonical_document_stability.parse_weight_accumulated IS
  'S73.5 (Session 80) Layer 2 trust-weighted + time-decayed cumulative weight. effective_weight = trust_weight × time_decay_multiplier per parse. Stability fires when sum ≥ 3.0. v3 identical_parse_count remains as a fallback diagnostic (v4 flag OFF → v3 behavior preserved).';

COMMENT ON COLUMN canonical_document_stability.smart_skip_count IS
  'S73.5 (Session 80) Layer 5 every-5th-smart-skip forced re-parse counter. Increments on each smart-skipped upload. When (smart_skip_count % 5 == 0) → forced full-parse on next upload (drift detection on very-low-activity hashes).';

COMMENT ON COLUMN canonical_document_stability.last_full_parse_at IS
  'S73.5 (Session 80) Layer 5 temporal staleness threshold tracker. now() - last_full_parse_at > threshold(scale) → forced full-parse. Thresholds: 90d (0-100), 90d (101-10K), 120d (10K-1M), 180d (1M+).';

-- ── 8. ALTER insurance_plans — historical_only flag ──────────────────────────

ALTER TABLE insurance_plans
  ADD COLUMN IF NOT EXISTS historical_only BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN insurance_plans.historical_only IS
  'S73.5 (Session 80) Subplan §2.10 plan-year-aware routing. TRUE when doc was uploaded outside the validity window [plan_year_start - 6mo, plan_year_end + 18mo]. Available for user own dispute references with disclaimer; does NOT contribute to ANY canonical stability or coverage. Computed by src/lib/plan/year-validity-window.ts.';

-- ── 9. canonical_field_corroboration AFTER INSERT trigger ────────────────────
--
-- Maintains distinct_user_count + distinct_document_count for the unique
-- (canonical, service_slug, field_name, value_hash) tuple. Use crypto SHA-256
-- of canonicalized JSONB (sorted-keys JSON.stringify) for stable hashing.
--
-- NOTE: Postgres' built-in JSONB doesn't have a stable canonical serializer, so
-- we use jsonb_path_query_first + the row's text cast. For MVP correctness, the
-- value_hash is sha256(jsonb_to_text), which is deterministic for the same
-- jsonb logical value across rewrites (because Postgres canonicalizes JSONB on
-- storage). This means {"a": 1, "b": 2} and {"b": 2, "a": 1} hash identically.

CREATE OR REPLACE FUNCTION update_canonical_field_corroboration()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_value_hash TEXT;
  v_existing RECORD;
BEGIN
  -- Only contribute when source_excerpt_verified='verified' AND
  -- source_section_verified=TRUE (Pattern P-8 cite-grade gate). Non-cite-grade
  -- rows are still useful for telemetry but don't count toward corroboration.
  IF NEW.source_excerpt_verified IS DISTINCT FROM 'verified'
     OR NEW.source_section_verified IS DISTINCT FROM TRUE THEN
    RETURN NEW;
  END IF;

  -- SHA-256 of canonical JSONB text (Postgres normalizes JSONB on storage,
  -- making text cast deterministic for same logical value).
  v_value_hash := encode(digest(NEW.extracted_value::text, 'sha256'), 'hex');

  -- Try to UPSERT the corroboration row.
  INSERT INTO canonical_field_corroboration (
    canonical_plan_id,
    service_slug,
    field_name,
    extracted_value_hash,
    extracted_value_jsonb,
    distinct_user_count,
    distinct_document_count,
    first_seen_at,
    last_seen_at
  )
  VALUES (
    NEW.canonical_plan_id,
    NEW.service_slug,
    NEW.field_name,
    v_value_hash,
    NEW.extracted_value,
    1,
    1,
    NEW.created_at,
    NEW.created_at
  )
  ON CONFLICT (canonical_plan_id, COALESCE(service_slug, ''), field_name, extracted_value_hash)
  DO UPDATE SET
    -- Distinct-user count: increment only if this user_id hasn't contributed
    -- to this tuple before. Probe via a count-existing-rows-with-this-user
    -- subquery on canonical_haiku_extractions (the trigger's source table).
    distinct_user_count = canonical_field_corroboration.distinct_user_count + (
      CASE WHEN NOT EXISTS (
        SELECT 1 FROM canonical_haiku_extractions che
        WHERE che.canonical_plan_id = NEW.canonical_plan_id
          AND COALESCE(che.service_slug, '') = COALESCE(NEW.service_slug, '')
          AND che.field_name = NEW.field_name
          AND che.user_id = NEW.user_id
          AND che.source_excerpt_verified = 'verified'
          AND che.source_section_verified = TRUE
          AND che.id <> NEW.id
          AND encode(digest(che.extracted_value::text, 'sha256'), 'hex') = v_value_hash
      ) THEN 1 ELSE 0 END
    ),
    -- Distinct-document count: increment only if this document_id hasn't
    -- contributed before.
    distinct_document_count = canonical_field_corroboration.distinct_document_count + (
      CASE WHEN NOT EXISTS (
        SELECT 1 FROM canonical_haiku_extractions che
        WHERE che.canonical_plan_id = NEW.canonical_plan_id
          AND COALESCE(che.service_slug, '') = COALESCE(NEW.service_slug, '')
          AND che.field_name = NEW.field_name
          AND che.document_id = NEW.document_id
          AND che.source_excerpt_verified = 'verified'
          AND che.source_section_verified = TRUE
          AND che.id <> NEW.id
          AND encode(digest(che.extracted_value::text, 'sha256'), 'hex') = v_value_hash
      ) THEN 1 ELSE 0 END
    ),
    last_seen_at = NEW.created_at;

  RETURN NEW;
END;
$fn$;

-- pgcrypto extension is required for digest() — enable if not already.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP TRIGGER IF EXISTS trg_update_canonical_field_corroboration
  ON canonical_haiku_extractions;

CREATE TRIGGER trg_update_canonical_field_corroboration
AFTER INSERT ON canonical_haiku_extractions
FOR EACH ROW
EXECUTE FUNCTION update_canonical_field_corroboration();

COMMENT ON FUNCTION update_canonical_field_corroboration() IS
  'S73.5 (Session 80). AFTER INSERT trigger on canonical_haiku_extractions. Maintains canonical_field_corroboration distinct-user + distinct-document counters per (canonical, service_slug, field_name, value_hash) tuple. Only cite-grade rows (source_excerpt_verified=verified AND source_section_verified=TRUE) contribute. Non-cite-grade rows skipped — return NEW unchanged.';

-- ── 10. Feature flag seeds ───────────────────────────────────────────────────
--
-- Mirrors mig 075 INSERT shape (per feedback_candid_feature_flag_schema):
-- (flag_key, enabled, description, target_type, config) — NOT (flag_key, scope).

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'cf40_v4_algorithm',
  FALSE,
  'S73.5 (Session 80). CF-40 v4 smart-skip + per-doc-type promotion algorithm. When OFF (default), CF-40 v3 behavior preserved: per-(canonical, hash) stability with multi-slot candidates + outlier eviction (mig 081+082 mechanic). When ON, v4 5-layer scale-aware algorithm fires: Layer 1 validity gates + Layer 2 trust-weighted/time-decayed stability + Layer 3 per-(canonical, doc_type) 3-criteria promotion + Layer 4 slow-drift/rapid-change/verification mode invalidation + Layer 5 forced re-parse sampling. Flag flipped post-MVP after telemetry validates each layer. Pattern 1 #16 in Candid_Data_Patterns.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'admin_attestation_enabled',
  TRUE,
  'S73.5 (Session 80) Q-S73.5-16 LOCK. Admin attestation as MVP cold-start lever. When ON (default for MVP — pre-launch low-user-count scale), admin uploads bypass Layer 3a + 3b corroboration (Layer 3c coverage still required; ≥2 admin uploads per doc-type per Q-S73.5-21 LOCK). Same Verified badge as organic (no separate "Admin Verified" tier per Q-S73.5-13 + Q-S73.5-18 LOCK). Audit trail in canonical_promotion_events.event_type=admin_attested. Flag flipped OFF post-MVP when organic Pattern 1 #3 fires reliably (~10K+ users on popular plans).',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;

-- ── Backfill note ─────────────────────────────────────────────────────────────
--
-- canonical_field_corroboration is initially empty. The trigger only fires on
-- NEW inserts to canonical_haiku_extractions, so existing cite-grade rows from
-- S72 onward are NOT auto-counted. Run scripts/backfill-canonical-field-
-- corroboration.ts post-deploy (admin-triggered; ~5-15 min on current data
-- volume) to backfill from existing canonical_haiku_extractions rows. Until
-- backfill completes, getDisputeLetterTreatment() falls back to existing
-- field_provenance behavior (graceful degradation).
