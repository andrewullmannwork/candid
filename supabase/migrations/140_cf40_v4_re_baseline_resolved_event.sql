-- =============================================================================
-- MIGRATION 140 — CF-40 v4 Layer 4: re_baseline_resolved invalidation event (Ing-D.0c)
-- =============================================================================
--
-- WHY (Ing-D.0c — pre-launch backend hardening, Session 158):
--   CF-40 v4 Layer 4 (mig 086) modeled the full open->close lifecycle for
--   verification-mode (`verification_mode_triggered` + `_resolved_noise` +
--   `_resolved_drift`) but only the OPEN side of the slow-drift / rapid-change ->
--   re-baseline path (`slow_drift_invalidation` / `rapid_change_invalidation`
--   with no matching CLOSE event). That asymmetry was a leftover from the
--   never-wired reset path: nothing ever cleared `re_baseline_required`, so no
--   close event existed.
--
--   Ing-D.0c wires the reset loop — when a re-baselining canonical re-accumulates
--   and re-meets Layer 3 promotion, `re_baseline_required` clears and the doc-type
--   re-promotes. Clearing that flag is a canonical-side MAINTENANCE write, and
--   Pattern 1 #14 requires it be logged explicitly (NOT a silent parser-side
--   write — that is the entire purpose of canonical_invalidation_events). This
--   migration adds the matching CLOSE event type so the invalidate->recover
--   lifecycle is fully auditable + queryable (invalidate->recover time
--   distribution; reaffirmed-vs-rebased via the value columns on the open/close
--   pair).
--
-- WHAT THIS MIGRATION ADDS:
--   1. Adds 're_baseline_resolved' to the canonical_invalidation_events.event_type
--      CHECK constraint (additive enum value). No new columns; no data change.
--
-- ROLLBACK:
--   Additive enum value only. cf40_v4_algorithm is OFF in PROD -> no Layer 4 code
--   path fires -> zero PROD rows will carry 're_baseline_resolved'. Rollback =
--   restore the prior CHECK (drop the value). Safe precisely because no PROD rows
--   use it. The DROP below is constraint-name-agnostic (resolves via pg_constraint)
--   so it is robust to PG's auto-generated inline-CHECK name + idempotent on
--   re-run.
--
-- DEPENDENCIES: mig 086 (canonical_invalidation_events table + event_type CHECK).
-- =============================================================================

BEGIN;

-- Drop the existing event_type CHECK name-agnostically. PG auto-named the inline
-- column CHECK `canonical_invalidation_events_event_type_check`, but resolve it
-- dynamically so this never silently leaves a stale stricter CHECK in place
-- (which would reject 're_baseline_resolved' even after the ADD below).
DO $$
DECLARE
  v_conname TEXT;
BEGIN
  SELECT con.conname
    INTO v_conname
  FROM pg_constraint con
  WHERE con.conrelid = 'canonical_invalidation_events'::regclass
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%event_type%';

  IF v_conname IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE canonical_invalidation_events DROP CONSTRAINT %I',
      v_conname
    );
  END IF;
END $$;

ALTER TABLE canonical_invalidation_events
  ADD CONSTRAINT canonical_invalidation_events_event_type_check
  CHECK (event_type IN (
    'slow_drift_invalidation',
    'rapid_change_invalidation',
    'rapid_change_pending_admin_review',
    'admin_manual_invalidation',
    'verification_mode_triggered',
    'verification_mode_resolved_noise',
    'verification_mode_resolved_drift',
    're_baseline_resolved'
  ));

COMMENT ON CONSTRAINT canonical_invalidation_events_event_type_check
  ON canonical_invalidation_events IS
  'Ing-D.0c (mig 140) added re_baseline_resolved — the CLOSE event for the slow_drift/rapid_change -> re_baseline lifecycle (parity with verification_mode open/close). Written when re_baseline_required clears after a re-baselining canonical re-meets Layer 3 promotion. The open event holds the pre-drift baseline_value_jsonb; the close event snapshots the rebuilt served value in divergent_value_jsonb so reaffirmed (false-alarm) vs rebased (real change) is queryable.';

COMMIT;
