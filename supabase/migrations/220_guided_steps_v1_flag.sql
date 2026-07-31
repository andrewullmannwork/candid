-- =============================================================================
-- MIGRATION 220 — Guided Steps v1 feature flag (S297)
-- =============================================================================
--
-- Seeds the `guided_steps_v1` row in `feature_flag_rules`. One flag gates all
-- Guided Steps v1 surfaces (handoff: plans/guided-steps-v1-implementation-
-- handoff-2026-07-30.md):
--   - Pack A' "Work it by phone first" — the step-4 phone subflow on /claim
--     bill detail (insurer-track + provider-track variants, scripts autofilled
--     from the bill's own payload, claim-scoped attested check-offs).
--   - Pack C "Collections guard-rail" — dispute-spine steps around the
--     existing debt_validation letter + the live FDCPA §1692g 30-day clock.
--   - Pack D "Take it to a regulator" — the complaint-doors checklist at the
--     ladder's terminal rung.
--   - Done rail-step collapse on /claim (steps 1-2 collapse to header +
--     "Show full step" when done; Andrew S297).
--
-- OFF = byte-identical pages (components not mounted; rail stays always-
-- expanded). Client reads go through GET /api/feature-flags/guided_steps_v1
-- (key added to EXPOSED_FLAGS in the same PR).
--
-- ROLLOUT: merge OFF → deploy → DEV flag-ON E2E already done pre-PR → PROD
-- Studio-apply at promote → prod flag-OFF smoke → separate Andrew go for the
-- PROD flip.
--
-- ROLLBACK: flip flag OFF (UPDATE feature_flag_rules SET enabled=false WHERE
-- flag_key='guided_steps_v1') — all surfaces unmount; persisted check-offs in
-- claims.metadata.guideSteps / dispute metadata are inert data, untouched.
-- Row removal (DELETE FROM feature_flag_rules WHERE flag_key='guided_steps_v1')
-- only if the feature is abandoned pre-flip.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'guided_steps_v1',
  false,
  'S297 (2026-07-30). Guided Steps v1 — checkable, collapsible step packs on existing surfaces: Pack A'' phone-first subflow inside /claim step 4 (track-aware call scripts autofilled from the bill payload, attested-only checkboxes with server timestamps + optional notes), Pack C collections guard-rail on the dispute spine (existing debt_validation letter + live FDCPA 30-day window), Pack D regulator complaint doors at the ladder terminal rung, and done-step collapse for /claim rail steps 1-2. No new letters, no new clocks, nothing auto-advances. OFF = byte-identical pages.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

-- Verify:
-- SELECT flag_key, enabled, target_type, config FROM feature_flag_rules WHERE flag_key = 'guided_steps_v1';
-- Expect: 1 row, enabled = false, target_type = 'global', config = {}.
