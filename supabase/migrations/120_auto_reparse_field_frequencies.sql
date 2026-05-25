-- =============================================================================
-- MIGRATION 120 — Auto-reparse field frequencies + flag (Ing-A, pre-launch
--                 backend hardening)
-- =============================================================================
--
-- Adds a per-field event-log telemetry table that records every fire of the
-- post-promotion auto-reparse triage (Ing-A) plus the `auto_reparse_enabled`
-- feature flag that gates the new hook in commitUploadAndEvaluateCorroboration.
--
-- WHY THIS MIGRATION EXISTS
--
-- Per `plans/pre_launch_backend_hardening.md` block Ing-A: today silent data
-- loss accumulates on every parse where Haiku returns a null / unverified /
-- low-confidence value for a P-8-bearing field. A user-triggered reparse path
-- (src/lib/plan/reparse-field.ts) already exists but pre-launch users won't
-- click "re-extract this field" — so the data never gets a second chance.
--
-- Ing-A adds an automatic post-P-8-verifier hook that iterates over the
-- candidates evaluated in commitUploadAndEvaluateCorroboration and, for any
-- field matching the triage rule, dispatches a targeted batched re-parse via
-- a NEW reparseFieldsBatch() peer function (cost-optimized; one Haiku call
-- per un-searched section, all requested fields projected). The triage rule:
--
--    reparse if (value IS NULL)
--           OR (source_excerpt_verified <> 'verified')
--           OR (haiku_confidence < 0.5)
--
-- Hard rule preserved: per Pattern P-2, haiku_confidence is METADATA ONLY,
-- never blended into the stored confidence score. The triage condition is
-- the ONLY place it reads from field_provenance to drive a decision.
--
-- Cap: 3 auto-reparse fires per upload (D3 lock from S126), enforced by
-- counting prior fires for the upload's document_id in this telemetry table.
--
-- WHAT THIS MIGRATION ADDS
--
-- 1. auto_reparse_field_frequencies table — append-only event log; one row
--    per (field, upload) triage fire. Captures trigger_reason, confidence,
--    cost, and outcome so Phase 6+ calibration can tune per-field thresholds.
-- 2. auto_reparse_enabled feature flag — seeded OFF + global. Ships dark;
--    flipped ON post-soak via staged rollout (admin-only → 25% → global per
--    Ing-A plan Sub-task 10).
--
-- TELEMETRY SHAPE — EVENT-LOG (D1 lock at S126)
--
-- One row per field-fire (not aggregated). This matches Candid's other
-- event-log telemetry tables (parse_audit_runs, audit_log) and keeps queries
-- simple — per-field rolling counts are GROUP BY field_name; per-upload cap
-- is COUNT(*) WHERE document_id = $1. Rationale rejected: JSONB-on-
-- parse_audit_runs requires nested JSON path expressions for the cap query
-- AND couples reparse retention to audit-run retention.
--
-- TRIGGER REASON ENUM
--
--    'null_value'         — Haiku returned null OR no row promoted for slot
--    'unverified_excerpt' — value present but source_excerpt_verified != 'verified'
--    'low_confidence'     — value present + verified but haiku_confidence < 0.5
--
-- Mutually exclusive in practice (evaluated in order); the first matching
-- reason wins. Field-CHECK enforces the closed set.
--
-- REPARSE OUTCOME ENUM
--
--    'reparse_changed_value'        — value updated post-reparse
--    'reparse_confirmed_null'       — second pass also produced null (real gap)
--    'reparse_no_change'            — same value, no churn
--    'reparse_skipped_cap'          — 3-fire cap hit for this upload
--    'reparse_skipped_no_sections'  — all sections already searched
--    'reparse_failed'               — exception or downstream error
--
-- BACKOUT — additive only. New table can be dropped; existing tables
-- untouched. Feature flag row can be deleted if rolling back. No FKs added
-- to canonical_plans or documents to keep this migration loosely coupled —
-- canonical_plans is append-only in practice, and forensic telemetry should
-- survive a hypothetical document deletion.

BEGIN;

-- ============================================================================
-- SECTION 1: auto_reparse_field_frequencies table
-- ============================================================================

CREATE TABLE IF NOT EXISTS auto_reparse_field_frequencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_plan_id UUID NOT NULL,
  document_id UUID NOT NULL,
  field_name TEXT NOT NULL,
  service_slug TEXT,
  trigger_reason TEXT NOT NULL
    CHECK (trigger_reason IN ('null_value', 'unverified_excerpt', 'low_confidence')),
  confidence_at_trigger NUMERIC(4,3),
  reparse_outcome TEXT NOT NULL
    CHECK (reparse_outcome IN (
      'reparse_changed_value',
      'reparse_confirmed_null',
      'reparse_no_change',
      'reparse_skipped_cap',
      'reparse_skipped_no_sections',
      'reparse_failed'
    )),
  reparse_cost_usd NUMERIC(8,5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_arff_document_id
  ON auto_reparse_field_frequencies (document_id);

CREATE INDEX IF NOT EXISTS idx_arff_field_name_created_at
  ON auto_reparse_field_frequencies (field_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_arff_created_at
  ON auto_reparse_field_frequencies (created_at DESC);

COMMENT ON TABLE auto_reparse_field_frequencies IS
  'Ing-A (S127). Append-only event log of auto-reparse triage fires. One row per (field, upload) triage event. Captures trigger reason, confidence at trigger time, batched-reparse cost attribution, and outcome. Used to: (a) enforce per-upload 3-fire cap via COUNT(*) WHERE document_id = $1 (D3 lock); (b) power /admin/auto-reparse-stats per-field rolling 7d view; (c) drive Phase 6+ per-field threshold calibration. No FKs to canonical_plans or documents — telemetry survives plan/doc deletion. Server-only writes via triage helper; no RLS.';

COMMENT ON COLUMN auto_reparse_field_frequencies.canonical_plan_id IS
  'Canonical plan whose field_provenance entry triggered the reparse. Soft reference; no FK to keep migration loosely coupled.';

COMMENT ON COLUMN auto_reparse_field_frequencies.document_id IS
  'The upload (documents.id) whose parse triggered this fire. Used for the D3 per-upload cap (≤3 fires per documents.id). Soft reference; no FK so forensic rows survive doc deletion.';

COMMENT ON COLUMN auto_reparse_field_frequencies.field_name IS
  'P-8-bearing field name in field_provenance (e.g., "deductible_individual", "office_visit_copay"). Used for per-field calibration aggregates.';

COMMENT ON COLUMN auto_reparse_field_frequencies.service_slug IS
  'Service slug for service-scoped fields (e.g., "primary_care_visit"); NULL for plan-identity fields. Disambiguates same-named fields across services.';

COMMENT ON COLUMN auto_reparse_field_frequencies.trigger_reason IS
  'Which triage condition fired. ''null_value'' = no value in field_provenance; ''unverified_excerpt'' = value present but source_excerpt_verified != ''verified''; ''low_confidence'' = value verified but haiku_confidence < 0.5. Evaluated in that order; first match wins.';

COMMENT ON COLUMN auto_reparse_field_frequencies.confidence_at_trigger IS
  'Haiku confidence at trigger time (0-1). Populated only when trigger_reason = ''low_confidence''; NULL otherwise.';

COMMENT ON COLUMN auto_reparse_field_frequencies.reparse_outcome IS
  'Result of the batched reparse for this field. ''reparse_changed_value'' = value updated; ''reparse_confirmed_null'' = second pass also null (real gap); ''reparse_no_change'' = same value; ''reparse_skipped_cap'' = 3-fire cap hit; ''reparse_skipped_no_sections'' = all sections already searched; ''reparse_failed'' = exception.';

COMMENT ON COLUMN auto_reparse_field_frequencies.reparse_cost_usd IS
  'USD cost attributed to this field for the batched reparse call. Total Haiku cost / fields requested in that batch (even attribution). NULL when reparse_outcome = ''reparse_skipped_*'' (no Haiku spend).';

-- ============================================================================
-- SECTION 2: auto_reparse_enabled feature flag
-- ============================================================================
-- Seeded OFF + global. Ships dark; flipped ON post-soak per Ing-A staged
-- rollout (admin-only → 25% → global). Empty config; gating is binary on/off.

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'auto_reparse_enabled',
  false,
  'Ing-A (S127). Gates the post-promotion auto-reparse triage hook in commitUploadAndEvaluateCorroboration. ON = for each promoted candidate, evaluate triage rule (value==null OR source_excerpt_verified!=''verified'' OR haiku_confidence<0.5) + dispatch batched reparse (cap 3 fires per upload). OFF = no-op (hook skipped). Default OFF; flipped ON post-soak via staged rollout.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
