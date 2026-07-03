-- =============================================================================
-- MIGRATION 196 — dispute-letters v2 S4: Deadline & Follow-up Engine (schema + flags)
-- =============================================================================
--
-- Dispute-letters v2 §3 (map: dispute-letters-v2-implementation-map.md §3/§3.5/§4).
-- The deadline & follow-up engine: track the clock, never write a doomed letter, and
-- keep the case in front of Compliance/Appeals before the governing deadline.
--
-- This migration is the FIRST of the S4 build and is ADDITIVE ONLY (Data Rule #7):
--   (1) 2 additive columns on dispute_outcomes (computed at letter generation).
--   (2) A new OFF feature flag that gates ALL new deadline behavior (fail-closed;
--       OFF = byte-identical goldens + today's flat 30/14 follow-up cadence).
--   (3) An additive config seed on the EXISTING dispute_feedback_loop flag so the
--       cadence/window knobs are tunable in one place (no hardcoded intervals —
--       project_ing_d_aggregation_ts_decision). Code carries identical fallbacks.
--
-- WHAT THE COLUMNS HOLD (populated by src/lib/disputes deadline engine, S4 later steps):
--   governing_deadline_date  DATE  — the actionable deadline the follow-ups track for
--                                    this dispute (NULL = no governing deadline → today's
--                                    behavior; fail-closed). Set-once: computed on the
--                                    dispute_outcomes INSERT, preserved on dedup re-draft
--                                    (never move a started clock).
--   deadline_type            TEXT  — which deadline governs. One of (code-constrained by
--                                    a TS union; intentionally NO DB CHECK so a future
--                                    registry-gated track needs no ALTER — Rule #7):
--                                      'erisa_appeal_180'  (denial-notice date + 180d; guard)
--                                      'plan_response'     (I1 sent + 60d post-service / 30d pre)
--                                      'fdcpa_validation_30'(collector first contact + 30d)
--                                      'state_timely_billing'(bill date; registry-gated → INERT)
--
-- FLAG dispute_deadline_engine_v1 (OFF):
--   Gates deadline compute + past-window guard + graduated follow-up LETTERS. OFF →
--   governing_deadline_date stays NULL, no guard, follow-ups keep the flat 30/14 cadence
--   → byte-identical to today. Flip ON post-deploy (Andrew-approved) once S4 code lands:
--     UPDATE feature_flag_rules SET enabled=true WHERE flag_key='dispute_deadline_engine_v1';
--
-- CONFIG SEED on dispute_feedback_loop (defaults || config → existing values always win,
--   new keys filled; non-clobbering + safe to re-apply):
--   deadline_buffer_days  10        — final-notice follow-up fires this many days BEFORE
--                                     the governing deadline.
--   deadline_window_days  {..}      — per-track window lengths (statutory defaults; counsel-
--                                     blessed map §10: ERISA 180 / plan-response 60 post-
--                                     service, 30 pre-service / FDCPA 30).
--   follow_up_fractions   [.33,.66] — graduated interim points as a fraction of the window
--                                     (final rung is deadline − deadline_buffer_days).
--
-- ROLLBACK (safe — flag OFF, columns NULL, nothing reads them until S4 later steps ship):
--   ALTER TABLE public.dispute_outcomes DROP COLUMN IF EXISTS governing_deadline_date;
--   ALTER TABLE public.dispute_outcomes DROP COLUMN IF EXISTS deadline_type;
--   DELETE FROM public.feature_flag_rules WHERE flag_key='dispute_deadline_engine_v1';
--   UPDATE public.feature_flag_rules SET config = config
--     - 'deadline_buffer_days' - 'deadline_window_days' - 'follow_up_fractions'
--     WHERE flag_key='dispute_feedback_loop';
-- =============================================================================

-- (1) Additive columns — computed at letter generation, fail-closed NULL.
ALTER TABLE public.dispute_outcomes
  ADD COLUMN IF NOT EXISTS governing_deadline_date DATE;

ALTER TABLE public.dispute_outcomes
  ADD COLUMN IF NOT EXISTS deadline_type TEXT;

COMMENT ON COLUMN public.dispute_outcomes.governing_deadline_date IS
  'Dispute-letters v2 S4 (mig 196). The actionable deadline the follow-ups track for this dispute. NULL = no governing deadline (fail-closed → flat cadence). Set-once: computed on INSERT, preserved on dedup re-draft.';

COMMENT ON COLUMN public.dispute_outcomes.deadline_type IS
  'Dispute-letters v2 S4 (mig 196). Which deadline governs: erisa_appeal_180 | plan_response | fdcpa_validation_30 | state_timely_billing (INERT, registry-gated). Code-constrained by a TS union; intentionally NO DB CHECK so a future track needs no ALTER (Rule #7).';

-- (2) Behavior flag — OFF (fail-closed; OFF = byte-identical goldens + flat 30/14 cadence).
INSERT INTO public.feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'dispute_deadline_engine_v1',
  false,
  'Dispute-letters v2 S4 (map §3). Gates the deadline & follow-up engine: (a) compute dispute_outcomes.governing_deadline_date + deadline_type at letter generation from denial-notice / collector-first-contact / bill dates; (b) past-window guard — before a deadline-bound letter, if past the window do NOT assert within-window, surface the correct next step (e.g. past internal-appeal → external review), if close flag urgency; (c) graduated follow-up LETTERS on the existing dispute_followups timer at ~1/3, ~2/3, and final-notice (deadline − buffer) → Compliance (provider) / Appeals (insurer). Cadence/window knobs live on dispute_feedback_loop.config (no hardcoded intervals). OFF = byte-identical (governing deadline NULL, no guard, flat 30/14 follow-ups).',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

-- (3) Additive config seed on the EXISTING dispute_feedback_loop flag. `defaults || config`
--     puts existing config on the RIGHT so any already-present (or later-tuned) key wins;
--     only the three new deadline keys are filled. Non-clobbering + safe to re-apply.
UPDATE public.feature_flag_rules
SET config = '{
  "deadline_buffer_days": 10,
  "deadline_window_days": {
    "erisa_appeal_180": 180,
    "plan_response": 60,
    "plan_response_preservice": 30,
    "fdcpa_validation_30": 30
  },
  "follow_up_fractions": [0.33, 0.66]
}'::jsonb || config
WHERE flag_key = 'dispute_feedback_loop';
