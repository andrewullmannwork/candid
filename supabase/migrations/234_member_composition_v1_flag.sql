-- =============================================================================
-- MIGRATION 234 — member_composition_v1 feature flag seed (S326, PR-A / §3.4)
-- =============================================================================
--
-- Seeds the `member_composition_v1` row in `feature_flag_rules`. The flag gates
-- the ELEVEN-RULES composition step (the §3.4 conduct redesign — the member,
-- not the engine, selects which dispute grounds a letter argues):
--   · the pre-generate composition step (facts in neutral voice → the FULL
--     ground catalog, fixed order, nothing pre-checked, nothing ranked →
--     member checkboxes filter facts to grounds via the static published
--     mapping) for the ground-arguing letter types;
--   · `selectedGrounds` REQUIRED on /api/disputes/generate for in-scope
--     types when ON (absent -> 4xx fail-closed);
--   · the member-adopted citations menu on insurer-directed letters;
--   · the "grounds I have selected myself" letter lead-in;
--   · the litigation screening QUESTION (the litigation_hold GATE itself is
--     unflagged — a legal gate must not be flaggable);
--   · `ground_selected` / `letter_adopted` spine events (the DFY operator
--     invariant's composition proof — s326-dfy-operator-build-handoff §5).
--
-- OFF = byte-identical to today's auto-compose path (all detected grounds
-- argued; goldens pin this MINUS the unflagged §81.101(c) conspicuous
-- statement + the unflagged original-creditor validation fix, which re-pin
-- once in this PR).
--
-- ROLLOUT: DEV-first (OPS.9); PROD apply rides the S326 promote on Andrew's
-- word; flip ON only after Andrew's dev E2E of the full composition step.
-- Rollback of behavior = flip OFF (letters revert to auto-compose).
--
-- ROLLBACK (of the seed itself):
--   DELETE FROM feature_flag_rules WHERE flag_key = 'member_composition_v1';
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'member_composition_v1',
  false,
  'S326 (PR-A / §3.4 eleven-rules). Gates the member composition step: neutral fact panel + full ground catalog (fixed order, nothing pre-checked or ranked) + member checkbox selection (required server-side when ON) + adopted-citations menu (insurer letters) + the selected-grounds lead-in + the litigation screening question + ground_selected/letter_adopted spine events. OFF = today''s auto-compose (all detected grounds argued). Flip ON after Andrew''s dev E2E. Rollback = flip OFF.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
