-- =============================================================================
-- MIGRATION 149 — Ing-E G7 PII-audit run ledger (S167)
-- =============================================================================
--
-- The daily PII-audit cron (GET /api/cron/pii-audit) writes ONE row per run here —
-- fire AND non-fire — satisfying Ship Gate G7 (recall-loss / silent-regression
-- detection: a periodic check that records BOTH outcomes). Two uses:
--   - LIVENESS: the latest run_at. If it is stale, the detector is offline; the cron
--     itself alerts on a >25h gap the next time it runs.
--   - TREND: "clean every day for N days" as a launch-readiness query.
--
-- AGGREGATE COUNTS ONLY. Unlike mig-144 pii_redaction_backfill_snapshot (which holds
-- pre-redaction PII and is locked down for that reason), this table never stores raw
-- excerpt text — only per-surface counts. It is internal backend telemetry, so it is
-- still service-role-only (no user access), but it is NOT itself a PII store.
--
-- ADDITIVE / BYTE-IDENTICAL ON APPLY: new table only; nothing else changes. The cron
-- begins writing rows once /api/cron/pii-audit deploys (Phase-2 PR).
--
-- BACKOUT: DROP TABLE pii_audit_runs;  (no other object references it.)

BEGIN;

CREATE TABLE IF NOT EXISTS pii_audit_runs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  trigger               TEXT NOT NULL DEFAULT 'cron'
                          CHECK (trigger IN ('cron', 'manual')),
  surfaces_swept        INTEGER NOT NULL,
  surfaces_errored      INTEGER NOT NULL DEFAULT 0,
  units_scanned         INTEGER NOT NULL,
  auto_pii_count        INTEGER NOT NULL,
  coverage_loss_count   INTEGER NOT NULL,
  non_idempotent_count  INTEGER NOT NULL,
  status                TEXT NOT NULL
                          CHECK (status IN ('clean', 'alert', 'error')),
  alerted               BOOLEAN NOT NULL DEFAULT false,
  detail                JSONB NOT NULL DEFAULT '{}'::jsonb,  -- per-surface aggregate counts (NO raw text)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Liveness/trend queries read newest-first.
CREATE INDEX IF NOT EXISTS idx_pii_audit_runs_run_at ON pii_audit_runs (run_at DESC);

-- Internal backend telemetry: no user access. RLS-enabled, no policies, service-role only.
ALTER TABLE pii_audit_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pii_audit_runs FROM anon, authenticated;
GRANT ALL ON pii_audit_runs TO service_role;

COMMENT ON TABLE pii_audit_runs IS
  'Ing-E G7 (S167). Daily PII-audit cron run ledger — AGGREGATE COUNTS ONLY (no raw PII). Liveness (latest run_at) + trend (clean streak) evidence for the cross-user PII detector. service-role only; never exposed via API.';

COMMIT;
