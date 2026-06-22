-- =============================================================================
-- MIGRATION 167 — "Change plan" feature flag (UX bugbash Stretch 1)
-- =============================================================================
--
-- Seeds the `change_plan_v1` row in `feature_flag_rules` so the "Change plan"
-- control on the /plan "Your plan on file" card (PlanSummaryCard) and the
-- server-side guard on POST /api/plan/set-active can be flipped global ON
-- post-deploy without a code change. Default OFF so the PR can merge + deploy
-- before the feature is exposed.
--
-- WHAT IT GATES:
--   - Client: the "Change plan" link on /plan (read via
--     /api/feature-flags/change_plan_v1).
--   - Server: POST /api/plan/set-active returns 404 when OFF (defense in depth
--     so the endpoint isn't reachable before launch).
--
-- FEATURE:
--   Lets a user replace their active insurance plan by picking one from the
--   canonical library (in-modal search → instant link-only swap) or by
--   uploading a new plan document (hands off to the existing /upload flow).
--   The search path performs a LINK-ONLY, user-scoped write: it sets
--   insurance_plans.canonical_plan_id (so /api/plan/analyze renders the
--   canonical plan's benefits) WITHOUT any canonical-table corroboration
--   side-effects (no source_count increment, no service merge) — a UI plan
--   selection is not a corroborating data source (Pattern 1 #14).
--
-- ROLLOUT:
--   1. Merge this migration with default OFF.
--   2. Deploy code (card link is hidden + endpoint 404s while OFF).
--   3. Flip global ON: UPDATE feature_flag_rules SET enabled=true
--      WHERE flag_key='change_plan_v1'.
--
-- ROLLBACK:
--   Flip flag OFF — the control disappears + the endpoint 404s. Removal of the
--   row is forbidden per Pattern 1 #10 hard-delete prohibition.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'change_plan_v1',
  false,
  'UX bugbash Stretch 1. Gates the "Change plan" control on the /plan plan-summary card + the POST /api/plan/set-active endpoint. When OFF, the card link is hidden and the endpoint returns 404. The search path links the user''s active insurance_plans row to an existing canonical_plans id (link-only, user-scoped: sets canonical_plan_id, repoints profiles.active_insurance_plan_id, deactivates the prior plan, clears stale profile cost/match fields) with NO canonical-table writes. The upload path hands off to the existing /upload flow. Flip global ON post-deploy.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
