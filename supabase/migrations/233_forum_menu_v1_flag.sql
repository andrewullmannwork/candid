-- =============================================================================
-- MIGRATION 233 — forum_menu_v1 feature flag seed (S325, PR-B / D4)
-- =============================================================================
--
-- Seeds the `forum_menu_v1` row in `feature_flag_rules`. The flag gates the
-- FREE-product forum-menu UI (Andrew's ruled PR structure: fixes unflagged →
-- free updates behind THIS flag → DFY behind its own flag):
--   · the screening questions in the case rail's regulator slot (coverage
--     type · the regulator the member's own documents name · the WA BBPA
--     opt-in check), persisted plan-level as
--     insurance_plans.metadata.regulatory_classification;
--   · the routed door tiles from src/lib/disputes/forums.ts (fixed role
--     order, nothing featured — R14; action-only forums render as
--     file-it-yourself link-outs; honest empty states);
--   · the routed letter consequence sentences (site B / external-review) —
--     note letter output varies by member DATA (the classification exists
--     only when the flag-ON UI wrote it), so flag-OFF letters stay
--     byte-identical to the PR-A neutral strings.
--
-- OFF = byte-identical to the PR-A state: the four generic doors (projected
-- from forums.ts fallback entries, fixture-pinned byte-exact), the legacy
-- suggestDoors ordering, the neutral consequence sentences.
--
-- NOT gated by this flag (PR-A, deliberately unflagged fixes): the neutral
-- agency-free closings, the citation registry + corrected citation forms,
-- the recoup-clause removal, the actionOnly composer throw.
--
-- ROLLOUT: applies DEV-first (OPS.9); PROD apply rides the batch promote
-- (#315 + #316 + PR-B) on Andrew's word; flip ON only after the dev E2E of
-- the full PR-B build (Andrew drives; screening → routed tiles → filing
-- record → letter consequence verified end-to-end).
-- Rollback of behavior = flip OFF (this row's `enabled` -> false).
--
-- ROLLBACK (of the seed itself):
--   DELETE FROM feature_flag_rules WHERE flag_key = 'forum_menu_v1';
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'forum_menu_v1',
  false,
  'S325 (PR-B / D4). Gates the free-product forum menu: rail screening questions (plan-level regulatory_classification) + routed door tiles from the verified forums registry (fixed order, nothing featured; action-only link-outs; honest empty states) + routed letter consequence sentences (data-driven; flag-OFF letters byte-identical to the PR-A neutral strings). OFF = the four generic doors + legacy ordering. Flip ON after the dev E2E of the full PR-B build. Rollback = flip OFF.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
