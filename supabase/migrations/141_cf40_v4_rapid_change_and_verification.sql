-- =============================================================================
-- MIGRATION 141 — CF-40 v4 Layer 4: rapid-change + verification-mode plumbing (Ing-D.0c-ii)
-- =============================================================================
--
-- WHY (Ing-D.0c-ii — pre-launch backend hardening, Session 159):
--   D.0c-i (mig 140) shipped slow-drift (§2.7a) + the re-baseline reset loop.
--   D.0c-ii adds the other two Layer-4 triggers — rapid-change (§2.7b) and
--   verification-mode (§2.7c). Both need a signal the recorder does not have
--   today: "was THIS parse a forced re-parse, and why?" That decision is made
--   upstream in the smart-skip orchestrator (shouldSkipExtraction →
--   evaluateV4SmartSkip → decideForcedReparse) during the INIT processing step,
--   but the recorder (recordParseEventV4) runs in a LATER QStash step (a separate
--   HTTP invocation). In-memory state does not cross that boundary, so the signal
--   must be PERSISTED on the document row at decide-time and read back at
--   record-time. This mirrors how mig 137 persists the Layer-1 contribution
--   verdict on `documents.cf40_layer1_passed`.
--
--   Separately, rapid-change needs a telemetry sink that captures BOTH fire and
--   non-fire (Ship Gate G7). slow-drift writes every evaluation to
--   canonical_drift_events, but that table is slow-drift-shaped (divergence_rate_30d)
--   with no detector discriminator. This migration generalizes it into the unified
--   Layer-4 detection-telemetry table so both detectors' fire+non-fire rows are
--   queryable and distinguishable.
--
-- WHAT THIS MIGRATION ADDS (both additive; no data change):
--   1. documents.cf40_forced_reparse_reason TEXT (nullable) — the Layer-5
--      forced-reparse reason persisted by the smart-skip orchestrator when a
--      parse is forced (verification_mode / statistical_drift_sample /
--      temporal_staleness / admin_upload / admin_attestation_validation /
--      every_5th_smart_skip). NULL = not a forced re-parse (or v4 flag OFF). Read
--      back by recordParseEventV4 to drive verification-mode open/resolve.
--   2. canonical_drift_events.detection_type TEXT NOT NULL DEFAULT 'slow_drift'
--      CHECK (IN ('slow_drift','rapid_change')) — discriminator so the table is
--      the unified Layer-4 detection-telemetry sink. DEFAULT preserves every
--      existing D.0c-i row as 'slow_drift' (back-compatible).
--   3. canonical_drift_events.window_days INT (nullable) — the detection window
--      the rate was computed over (30 for slow-drift; the scale-aware 7/14 for
--      rapid-change). NULL on legacy slow-drift rows (implicitly 30d).
--
--   Every Layer-4 EVENT TYPE rapid-change + verification-mode emit
--   (rapid_change_invalidation / rapid_change_pending_admin_review /
--   verification_mode_triggered / _resolved_noise / _resolved_drift) ALREADY
--   exists in the canonical_invalidation_events.event_type CHECK (mig 086 + the
--   mig 140 re-create), and canonical_plans.divergence_pending_verification +
--   canonical_divergence_review already exist (mig 086). No further schema is
--   needed for D.0c-ii — this migration is purely the two plumbing additions.
--
-- ROLLBACK:
--   Both additive. cf40_v4_algorithm is OFF in PROD → no Layer-4 code path fires →
--   cf40_forced_reparse_reason stays NULL on every row and no 'rapid_change' drift
--   rows are written. Rollback = DROP COLUMN documents.cf40_forced_reparse_reason +
--   DROP COLUMN canonical_drift_events.detection_type + DROP COLUMN
--   canonical_drift_events.window_days. Safe precisely because no PROD rows use them.
--
-- DEPENDENCIES: mig 086 (canonical_drift_events, canonical_plans.divergence_pending_verification,
--   canonical_invalidation_events, canonical_divergence_review), mig 137
--   (documents.cf40_layer1_passed pattern precedent), mig 140 (event_type CHECK).
-- =============================================================================

BEGIN;

-- ── 1. documents.cf40_forced_reparse_reason — persisted Layer-5 forced signal ──
-- ADD COLUMN ... NULL is metadata-only in Postgres (no table rewrite), safe on the
-- large documents table.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS cf40_forced_reparse_reason TEXT;

COMMENT ON COLUMN documents.cf40_forced_reparse_reason IS
  'Ing-D.0c-ii (mig 141). The CF-40 v4 Layer-5 forced-reparse reason for this document''s parse, persisted by the smart-skip orchestrator (shouldSkipExtraction → evaluateV4SmartSkip) at INIT-step decide-time so recordParseEventV4 can read it back at the LATER record-step (separate QStash invocation). One of: verification_mode | statistical_drift_sample | temporal_staleness | admin_upload | admin_attestation_validation | every_5th_smart_skip. NULL = not a forced re-parse (normal not-yet-stable extract, first-time hash, or cf40_v4_algorithm OFF). Drives Layer-4 verification-mode open (non-verification forced + divergent) vs resolve (verification_mode forced).';

-- ── 2-3. canonical_drift_events → unified Layer-4 detection telemetry ─────────
ALTER TABLE canonical_drift_events
  ADD COLUMN IF NOT EXISTS detection_type TEXT NOT NULL DEFAULT 'slow_drift'
    CHECK (detection_type IN ('slow_drift', 'rapid_change')),
  ADD COLUMN IF NOT EXISTS window_days INT;

COMMENT ON COLUMN canonical_drift_events.detection_type IS
  'Ing-D.0c-ii (mig 141). Which Layer-4 window detector wrote this row: slow_drift (§2.7a, 30d divergence-rate) or rapid_change (§2.7b, scale-aware convergence window). DEFAULT slow_drift back-fills every D.0c-i row. triggered_re_baseline still distinguishes fire vs non-fire within each detector (G7 fire+non-fire telemetry).';

COMMENT ON COLUMN canonical_drift_events.window_days IS
  'Ing-D.0c-ii (mig 141). The rolling window (days) the rate was computed over — 30 for slow_drift; the scale-aware 7 (cold_start) or 14 (small+) for rapid_change. NULL on legacy slow_drift rows (implicitly 30).';

COMMENT ON TABLE canonical_drift_events IS
  'S73.5 (Session 80); generalized Ing-D.0c-ii (mig 141). Unified Layer-4 detection telemetry. Rows written on EVERY slow-drift + rapid-change evaluation regardless of trigger (diagnostic; triggered_re_baseline flag distinguishes fire vs non-fire — Ship Gate G7). detection_type discriminates the two detectors; window_days records the window. Slow-drift rule: divergence_rate > 0.3 AND divergent_user_count >= 3 over 30d. Rapid-change rule: scale-aware distinct-user convergence on a plausible challenger within the scale window.';

COMMIT;
