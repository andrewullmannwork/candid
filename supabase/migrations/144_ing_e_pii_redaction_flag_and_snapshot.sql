-- =============================================================================
-- MIGRATION 144 — Ing-E PII redaction flag + pre-backfill snapshot table (S166)
-- =============================================================================
--
-- Seeds the `pii_redaction_enabled` rule flag that gates the cross-user PII
-- redactor, and creates the RESTRICTED rollback ledger for the Phase-3
-- destructive backfill. Mirrors the mig 143 / 134 / 136 flag-seed shape
-- (target_type + config JSONB; flag_key UNIQUE).
--
-- WHY THIS MIGRATION EXISTS
--
-- Ing-E redacts user-PII from CROSS-USER / shared surfaces at write time, so a
-- breach of the flywheel exposes no individuals (Rule #5 + Pattern 1 #9). The
-- redactor is wired at the canonical/shared write chokepoints; this flag turns it
-- on. In-scope shared free-text surfaces (redact the source prose; never the
-- coverage value — COVERAGE_GUARD):
--   - canonical_plans / canonical_plan_services  field_provenance.sources[].excerpt
--   - canonical_haiku_extractions.source_excerpt
--   - billing_code_identity.corroborator_sources[].raw_description
--   - billing_code_identity.description_examples          (writer-completeness §0)
--   - billing_code_mappings.provider_descriptions         (writer-completeness §0)
-- description_signature columns are matching keys — NOT redacted by design;
-- monitored by the G7 daily audit instead.
--
-- BYTE-IDENTICAL ON APPLY
--
-- The flag is seeded enabled=false → isPiiRedactionEnabled() returns false →
-- redaction skipped → no behavior change when this migration applies. The global
-- flip is a deliberate, post-validation Studio action (see FLIP below). The
-- snapshot table is empty until the Phase-3 backfill runs.
--
-- FLIP (after the pre-flip non-mutating validation passes):
--   UPDATE feature_flag_rules SET enabled = true WHERE flag_key = 'pii_redaction_enabled';
-- EMERGENCY ROLLBACK (instant, byte-identical; <=30s gate cache):
--   UPDATE feature_flag_rules SET enabled = false WHERE flag_key = 'pii_redaction_enabled';
--
-- THE SNAPSHOT TABLE IS ITSELF A PII STORE
--
-- pii_redaction_backfill_snapshot holds the PRE-redaction column values (the very
-- PII being removed) so the one-time backfill is per-row reversible (Architecture
-- A made-safe: snapshot -> dry-run/diff -> per-row coverage-preservation assert ->
-- apply). It is therefore RLS-enabled with NO policies + REVOKE'd from anon /
-- authenticated → reachable only by the service role. It must NEVER be exposed via
-- a user-facing API. Retention: purge/drop after the backfill soak clears (>=30d)
-- per plans/pre_launch_backend_hardening.md.
--
-- BACKOUT — additive only. DELETE the flag row (redactor falls back to OFF →
-- byte-identical) and DROP TABLE pii_redaction_backfill_snapshot. No existing
-- column/type is altered.

BEGIN;

-- 1. Redaction gate flag. OFF on apply (byte-identical); Studio flip -> global ON.
INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'pii_redaction_enabled',
  false,
  'Ing-E (S166). Gates the cross-user PII redactor (pii-redaction-gate.ts -> redactText). OFF/absent -> byte-identical (fail-open). Redacts user-PII from SHARED surfaces at write time: field_provenance.sources[].excerpt, canonical_haiku_extractions.source_excerpt, billing_code_identity.corroborator_sources[].raw_description + description_examples, billing_code_mappings.provider_descriptions. description_signature matching keys are NOT redacted by design (G7-audit monitored). Coverage tokens protected by COVERAGE_GUARD. Rollout: OFF -> global (safety feature; no pct/admin ramp). See progress_backend.md S166.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

-- 2. Pre-backfill snapshot — RESTRICTED rollback ledger for the Phase-3 redaction.
CREATE TABLE IF NOT EXISTS pii_redaction_backfill_snapshot (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id     TEXT NOT NULL,                  -- one backfill run
  surface      TEXT NOT NULL,                  -- '<table>.<column>'
  row_id       TEXT NOT NULL,                  -- target row PK (text; surfaces vary)
  pre_value    TEXT NOT NULL,                  -- full column value BEFORE redaction (PII)
  post_value   TEXT NOT NULL,                  -- full column value AFTER redaction
  patterns     TEXT[] NOT NULL DEFAULT '{}',   -- pattern names that fired
  redacted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One snapshot per (batch, surface, row) → the Phase-3 backfill is idempotent
  -- (INSERT ... ON CONFLICT DO NOTHING keeps the TRUE pre-redaction value on retry).
  UNIQUE (batch_id, surface, row_id)
);

-- (batch_id lookups use the UNIQUE constraint's leading column.) Index by-row
-- lookups for rollback of a specific (surface, row) across batches:
CREATE INDEX IF NOT EXISTS idx_pii_redaction_snapshot_surface_row
  ON pii_redaction_backfill_snapshot (surface, row_id);

-- RLS-enabled with NO policies → anon/authenticated denied; service role bypasses.
ALTER TABLE pii_redaction_backfill_snapshot ENABLE ROW LEVEL SECURITY;
-- PII store: strip anon/authenticated entirely, and explicitly grant ONLY the
-- service role (the backfill runs service-role). Explicit rather than relying on
-- default privileges — mirrors the repo's explicit-grant convention (e.g. mig 065).
REVOKE ALL ON pii_redaction_backfill_snapshot FROM anon, authenticated;
GRANT ALL ON pii_redaction_backfill_snapshot TO service_role;

COMMENT ON TABLE pii_redaction_backfill_snapshot IS
  'Ing-E (S166). RESTRICTED rollback ledger for the Phase-3 PII redaction backfill (Architecture A made-safe). Holds PRE-redaction values (PII) -> RLS-enabled, no policies, REVOKE''d from anon/authenticated -> service-role only; NEVER expose via API. Retention: purge/drop after backfill soak clears (>=30d) per plans/pre_launch_backend_hardening.md. One row per redacted (surface,row).';

COMMIT;
