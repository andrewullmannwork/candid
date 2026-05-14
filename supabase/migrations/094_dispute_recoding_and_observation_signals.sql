-- Mig 094 — S74.6 D5 + D4 secondary signals
--
-- Three additive concerns bundled per Subplan §6:
--
-- (1) D5 dispute outcome recoding capture:
--       dispute_outcomes.recoded_as_code      TEXT NULL — alternative code the insurer
--                                                        ultimately paid on
--       dispute_outcomes.recoded_as_code_type TEXT NULL — corresponding code type ('CPT',
--                                                        'HCPCS_L2', etc.)
--
-- (2) D4 three-tier dedup secondary signals (Subplan §12):
--       billing_code_identity.bill_observation_count           INT  DEFAULT 0 — incremented
--           on EVERY line-item match (no dedup beyond bill-level file-hash). Captures
--           frequency signal independent of cross-user discipline.
--       billing_code_identity.observed_provider_canonical_ids  UUID[] DEFAULT '{}'
--           — array of distinct providers observed. ADD provider_canonical_id IF not
--           already present. Length captures cross-provider convergence signal.
--
--     Both surfaced in admin UI for confidence context. v1 does NOT drive promotion
--     threshold (cross-user discipline preserved at 5 distinct verified users).
--     Phase 2 may incorporate into promotion math if telemetry shows
--     `distinct_provider_count` is more predictive at scale.
--
-- (3) pg_cron 90-day cleanup of ambiguous_candidate rows (Subplan §C admin
--     bootstrap / Q-S87-C3 lock). Drops rows with `promotion_state='ambiguous_candidate'`
--     older than 90 days with 0 user votes (i.e., no `user_correction` source entries).
--     Prevents table-pollution from drive-by Haiku ambiguity.
--
-- Backout per concern:
--   (1) DROP columns dispute_outcomes.recoded_as_code + recoded_as_code_type → D5
--       outcome capture no-ops; recoding pattern signal not captured.
--   (2) DROP columns billing_code_identity.bill_observation_count +
--       observed_provider_canonical_ids → admin UI loses secondary context;
--       promotion math unaffected (cross-user discipline alone preserved).
--   (3) UNSCHEDULE pg_cron job → ambiguous_candidate rows persist until manual cleanup.

BEGIN;

-- ── Concern 1: dispute_outcomes recoding capture ─────────────────────────────

ALTER TABLE dispute_outcomes
  ADD COLUMN IF NOT EXISTS recoded_as_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS recoded_as_code_type TEXT NULL;

COMMENT ON COLUMN dispute_outcomes.recoded_as_code IS
  'S74.6 D5 — when status=won_on_escalation, the alternative billing code the insurer paid on. NULL on losses, non-recoded wins, and pre-S74.6 outcomes. Feeds dispute_won_recoding source on billing_code_identity.';
COMMENT ON COLUMN dispute_outcomes.recoded_as_code_type IS
  'S74.6 D5 — code type for recoded_as_code (''CPT'' / ''HCPCS_L2'' / etc.). Paired field.';

-- ── Concern 2: billing_code_identity secondary signals ────────────────────────

ALTER TABLE billing_code_identity
  ADD COLUMN IF NOT EXISTS bill_observation_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS observed_provider_canonical_ids UUID[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN billing_code_identity.bill_observation_count IS
  'S74.6 D4 / Subplan §12 — incremented on every line-item match (no dedup beyond file-hash). Captures frequency signal. Does NOT drive promotion threshold v1; surfaced in admin UI for context.';
COMMENT ON COLUMN billing_code_identity.observed_provider_canonical_ids IS
  'S74.6 D4 / Subplan §12 — array of distinct provider_canonical_ids observed. Length = distinct_provider_count. Captures cross-provider convergence signal. Does NOT drive promotion threshold v1; surfaced in admin UI for context.';

-- ── Concern 3: pg_cron ambiguous_candidate cleanup ───────────────────────────
-- Conditional on pg_cron extension being installed (PROD has it via mig 086).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    -- Drop prior schedule if it exists (idempotent re-apply)
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 's74_6_ambiguous_candidate_cleanup';

    -- Schedule daily at 03:17 UTC. Drop ambiguous_candidate rows older than 90 days
    -- that never accumulated a user_correction vote (corroborator_sources lacks
    -- any user_correction source). Cross-USER discipline preserved by Pattern 1 #14.
    PERFORM cron.schedule(
      's74_6_ambiguous_candidate_cleanup',
      '17 3 * * *',
      $$
        DELETE FROM billing_code_identity
        WHERE promotion_state = 'ambiguous_candidate'
          AND created_at < now() - interval '90 days'
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(coalesce(corroborator_sources, '[]'::jsonb)) AS src
            WHERE src->>'source' = 'user_correction'
          );
      $$
    );
  ELSE
    RAISE NOTICE 'pg_cron extension not installed; skipping s74_6_ambiguous_candidate_cleanup schedule. Apply mig 086 to install + re-run this block.';
  END IF;
END $$;

COMMIT;
