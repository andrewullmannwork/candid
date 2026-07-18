-- =============================================================================
-- MIGRATION 207 — simplified onboarding: flag seed + completion state + backfill
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
--
--   Item-2 onboarding reorder (plan: onboarding_doc_first_reorder.md; v10 =
--   the 2026-07-17 "Simplified Onboarding" design handoff). Onboarding
--   completion becomes a durable STATE, not a session moment: routing
--   (post-signup redirect, /onboarding entry vs dashboard) and the profile-
--   meter lifecycle key off one timestamp instead of inferring "done" from
--   data presence (inference breaks on skipped steps — Q4: skips count as
--   done; the user saw the question and declined).
--
-- WHAT THIS MIGRATION ADDS
--   1. onboarding_simplified_v1 flag seed (OFF/global) — gates the ENTIRE
--      simplified onboarding (2026-07-17 design handoff, supersedes the v7
--      in-wizard build): the 3-step /onboarding route (card → plan doc or
--      bill → about you), the dashboard profile-strength meter, and the
--      flag-aware post-signup redirect.
--      OFF = byte-identical to today's card-first wizard flow.
--   2. users.onboarding_completed_at timestamptz — NULL = incomplete.
--      Stamped by the wizard-finish endpoint (P3; until then nothing writes
--      it and the flag stays OFF). NOTE: the plan doc names this column on
--      `profiles`, but profiles rows are wizard-created (NOT universal —
--      a user who never ran the wizard has none), while `users` is
--      1-row-per-account by construction. The no-nag backfill (#3) must
--      reach EVERY existing account, so the column lives on users.
--   3. Backfill — every existing account is stamped complete: they signed
--      up through the card-first flow and must NEVER see onboarding
--      prompts (plan §3 Risk 11).
--
-- FLIP RUNBOOK NOTE (P4): re-run the backfill UPDATE immediately before
--   flipping the flag ON — accounts created between this apply and the flip
--   also signed up card-first and must be stamped complete.
--
-- APPLY ORDER: DEV `wdpk…` first (localhost build/testing), PROD `viahl…`
--   before/at the P1 promote. Bare-statement paste per the mig-189 Studio
--   lesson (strip BEGIN/COMMIT + comments).
--
-- BACKOUT — flag OFF = byte-identical (no reader when OFF). Column is
--   additive (Rule 7); leave in place, or DROP COLUMN when convenient after
--   code no longer references it.

BEGIN;

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'onboarding_simplified_v1',
  false,
  'Simplified onboarding (2026-07-17 design handoff; plan: onboarding_doc_first_reorder.md v10, S285; supersedes the unshipped v7 in-wizard build). Gates: (1) the 3-step full-screen /onboarding route replacing the 7-step /profile wizard for incomplete accounts — step 1 insurance card (photo scan or typed insurer/member ID/group #), step 2 plan document or bill (parse runs in-step; a bill shows its audit result in-step), step 3 about you (household tiles, optional sex, required ZIP + DOB with signup pre-fill when present, situation chips) — every step skippable, finish or skip lands on the dashboard; (2) the dashboard profile-strength meter (no-docs amber callout / partial checklist with step deep-links / complete row); (3) the flag-aware post-signup redirect and the /profile?onboarding=true runtime redirect into /onboarding. Completion state = users.onboarding_completed_at (stamped at finish or skip — skips count as done). OFF = byte-identical card-first wizard flow; rollback = flip OFF. Re-run the mig-207 backfill immediately before flipping ON.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;

COMMENT ON COLUMN users.onboarding_completed_at IS
  'Simplified onboarding (mig 207): when onboarding was finished (skipped steps count as finished — Q4). NULL = incomplete; drives the post-signup redirect + /onboarding entry behind onboarding_simplified_v1. Existing accounts backfilled complete at mig 207 (no-nag guarantee); re-run the backfill right before the flag flip.';

UPDATE users
SET onboarding_completed_at = COALESCE(created_at, now())
WHERE onboarding_completed_at IS NULL;

COMMIT;
