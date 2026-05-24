-- =============================================================================
-- MIGRATION 118 — ShareWithFriend new surfaces feature flag (S124, B2.4)
-- =============================================================================
--
-- Seeds the `share_with_friend_new_surfaces_v1` row in `feature_flag_rules` so
-- the two NEW ShareWithFriend embed placements (dashboard + compare_picker)
-- introduced in B2.4 can be flipped OFF at the DB layer without a code deploy.
-- Default `enabled=true` so the placements ship live for testing speed
-- (pre-user-base; we don't have public users yet).
--
-- WHY:
--   Per Phase 2 Subplan §1.C.4-I, ShareWithFriend has 5 placements total —
--   3 PRESERVED (compare_results / upload_form / upload_complete) shipped
--   pre-B2.4 and are NOT flag-gated; 2 NEW (dashboard / compare_picker)
--   land in B2.4. Per `feedback_feature_flags_required`, the 2 NEW
--   placements need a flag. Per Andrew direction at S124, default ON
--   (pre-user-base, faster to test; rollback path = flip OFF in DB).
--
-- WHAT IT GATES:
--   - `<ShareWithFriend variant="soft" surface="dashboard" />` at the bottom
--     of /dashboard (below the "More from Candid" section)
--   - `<ShareWithFriend variant="soft" surface="compare_picker" />` in the
--     /compare picker view (build mode, below the "Compare these plans" CTA)
--
-- DOES NOT GATE:
--   - `surface="compare_results"` (full variant, /compare results view) — pre-existing
--   - `surface="upload_form"` (full variant, /upload page card) — pre-existing
--   - `surface="upload_complete"` (full variant, ParseTerminalView success) — pre-existing
--   - `surface="profile"` (soft variant, ProfileDashboard) — shipped via B2.1
--
-- ROLLBACK:
--   Flip flag OFF: UPDATE feature_flag_rules SET enabled=false
--   WHERE flag_key='share_with_friend_new_surfaces_v1'. The 2 NEW
--   placements stop rendering; 3 PRESERVED surfaces unaffected. Removal of
--   the row is forbidden per Pattern 1 #10 hard-delete prohibition.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'share_with_friend_new_surfaces_v1',
  true,
  'B2.4 (S124). Gates the 2 NEW ShareWithFriend embed placements introduced in Phase 2 batch B2.4: surface="dashboard" (soft variant, bottom of /dashboard) and surface="compare_picker" (soft variant, /compare build-mode view below CTA). Does NOT gate the 3 PRESERVED full-variant surfaces (compare_results / upload_form / upload_complete) or the profile soft-variant placement shipped via B2.1. Default ON pre-user-base for testing speed per Andrew direction at S124 kickoff; flip OFF at DB to remove the 2 NEW placements without a code deploy.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
