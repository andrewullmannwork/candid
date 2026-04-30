-- Migration 055: parse_audit_runs table for Phase 3 empirical harness (Task 3H).
-- Per Q-P3-5 lock + DR-3D dogfood findings (plans/findings/dr3d_dogfood_findings.md).
-- Stores per-fixture per-attempt recall + precision + cost telemetry from the harness.
-- Admin-only read; consumer = Task 3J /admin/parse-audit-runs UI + CLI report.
-- Additive schema; no rollback needed.

CREATE TABLE IF NOT EXISTS parse_audit_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT NOT NULL,                    -- groups multi-fixture runs ("session_47_dr3d_baseline")
  parser_version TEXT NOT NULL,            -- git SHA at run time
  parser_name TEXT NOT NULL,               -- 'sbc' | 'bill' | 'eob' | 'card'
  fixture_id TEXT NOT NULL,                -- 'cigna-2026-03-26-hira-mixed' | 'ambetter-ca-2024-bronze-60-hdhp'
  fixture_kind TEXT NOT NULL,              -- 'annotated' | 'bulk_unannotated' | 'synthetic'
  recall NUMERIC(4,3),                     -- NULL for bulk_unannotated
  precision NUMERIC(4,3),                  -- NULL for bulk_unannotated
  fields_captured INT,
  fields_total INT,
  fields_correct INT,
  cost_usd NUMERIC(8,5),
  haiku_tokens_input INT,
  haiku_tokens_output INT,
  haiku_cache_read_tokens INT DEFAULT 0,   -- DR-3D Q-DR-3D-1: cache_read_input_tokens (track cache hits)
  haiku_cache_create_tokens INT DEFAULT 0, -- DR-3D Q-DR-3D-1: cache_creation_input_tokens
  per_field_results JSONB,                 -- {field_name: {captured, correct, expected, actual}}
  warnings JSONB,                          -- DR-3D Q-DR-3D-6: {meta_warnings: [...], accumulator_warnings: [...]}
  parse_duration_ms INT,
  parse_attempt_idx INT,                   -- 1-N (N=3 stochastic-variance default per DR-3C)
  parse_status TEXT NOT NULL,              -- 'success' | 'timed_out' | 'extraction_failed' | 'truncated'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS parse_audit_runs_run_parser_fixture_idx
  ON parse_audit_runs (run_id, parser_name, fixture_id);

CREATE INDEX IF NOT EXISTS parse_audit_runs_parser_created_idx
  ON parse_audit_runs (parser_name, created_at DESC);

COMMENT ON TABLE parse_audit_runs IS
  'Phase 3 Task 3H empirical harness output. Tracks parser recall/precision/cost per fixture per attempt. See plans/findings/dr3d_dogfood_findings.md.';
