-- 175_dispute_status_allow_cancelled.sql
-- Cost-Share v2 lane (S214) — fix a latent dispute-cancellation bug surfaced
-- while clearing the cf91a49e false-positive dispute.
--
-- BUG: the app read-side treats status='cancelled' as "dispute closed"
--   - src/lib/claims/derive-bill-state.ts:104  hasDraftedDispute = some(d => d.status !== 'cancelled')
--   - src/components/claims/ClaimDetail.tsx (existingDisputeId = find(d => d.status !== 'cancelled'))
-- ...but the live CHECK constraint (mig 043) never allowed 'cancelled', so any
-- attempt to cancel a dispute is rejected by Postgres → disputes are effectively
-- un-cancellable in PROD. The `!== 'cancelled'` checks are dead today.
--
-- FIX: widen the CHECK to allow 'cancelled'. ADDITIVE (Rule #7) — only widens the
-- allowed set; no existing row changes; legacy values preserved verbatim.
--
-- Rollback (only safe before any row uses it):
--   ALTER TABLE dispute_outcomes DROP CONSTRAINT IF EXISTS dispute_outcomes_status_check;
--   ALTER TABLE dispute_outcomes ADD CONSTRAINT dispute_outcomes_status_check
--     CHECK (status IN ('filed','in_progress','won','lost','settled','withdrawn',
--       'won_on_escalation','settled_on_escalation','dispute_letter_drafted','court_documentation_drafted'));

BEGIN;

DO $$ BEGIN
  ALTER TABLE dispute_outcomes DROP CONSTRAINT IF EXISTS dispute_outcomes_status_check;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

ALTER TABLE dispute_outcomes
  ADD CONSTRAINT dispute_outcomes_status_check
  CHECK (status IN (
    -- legacy + lifecycle (mig 043), preserved verbatim
    'filed',
    'in_progress',
    'won',
    'lost',
    'settled',
    'withdrawn',
    'won_on_escalation',
    'settled_on_escalation',
    'dispute_letter_drafted',
    'court_documentation_drafted',
    -- NEW (mig 175): the closed-marker the app already reads on
    'cancelled'
  ));

COMMIT;

-- VERIFY (run in the same Studio editor after COMMIT — expect the def to include 'cancelled'):
-- SELECT pg_get_constraintdef(oid) AS def
-- FROM pg_constraint WHERE conname = 'dispute_outcomes_status_check';
