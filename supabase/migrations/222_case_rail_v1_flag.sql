-- =============================================================================
-- MIGRATION 222 — Case rail v1 feature flag (S299)
-- =============================================================================
--
-- Seeds the `case_rail_v1` row in `feature_flag_rules`. Gates the UI SURFACE
-- of timeline-unification phase 1 (handoff: plans/timeline-unification-phase1-
-- handoff-2026-07-31.md; approved mock: plans/mocks/s298-extended-rail-mock.html):
--   - the extended claim rail on /claim bill detail, rendered from the
--     case-timeline projector (per-letter waiting cards with days-since-sent +
--     response-due clocks, concurrent waits, collapsed history receipts)
--   - the case-header waiting chip ("Waiting on N responses · first due …")
--   - the "Collection resumed anyway" capture door
--     (POST /api/claims/[claimId]/case-events)
--
-- DELIBERATELY SEPARATE from `case_timeline_v1` (mig 221), which gates the
-- EVENT SPINE (emitters). The two want different clocks and different kill
-- switches: at promote time the spine turns ON immediately so real history
-- accumulates, while the rail UI waits for its own flip after the full-unit
-- DEV E2E — and a UI defect in PROD must be killable without stopping the
-- ledger. Spine ON + rail OFF is the intended PROD promote state.
--
-- OFF = byte-identical pages: the claim GET does not attach the projection,
-- CaseRail is not mounted, the door route 404s. Client reads go through
-- GET /api/feature-flags/case_rail_v1 (key added to EXPOSED_FLAGS in the
-- same PR).
--
-- ROLLOUT: merge OFF → DEV Studio-apply + DEV flag-ON E2E pre-merge → PROD
-- Studio-apply at promote (after mig 221) → prod flag-OFF smoke → separate
-- Andrew go for the PROD flip (after case_timeline_v1 is ON).
--
-- ROLLBACK: flip flag OFF (UPDATE feature_flag_rules SET enabled=false WHERE
-- flag_key='case_rail_v1') — rail unmounts, claim GET payload returns to
-- today's shape; the event ledger keeps writing (case_timeline_v1 untouched).
-- Row removal (DELETE FROM feature_flag_rules WHERE flag_key='case_rail_v1')
-- only if the feature is abandoned pre-flip.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'case_rail_v1',
  false,
  'S299 (2026-07-31). Case rail v1 — timeline-unification phase 1a UI: the extended claim rail on /claim bill detail renders the live phase from the case-timeline projector (per-letter waiting cards with days-since-sent + response-due clocks, concurrent waits, collapsed history receipts, case-header waiting chip, collection-resumed capture door). UI surface only — the event spine is gated separately by case_timeline_v1; spine ON + rail OFF is the intended promote state. OFF = byte-identical pages (projection not attached to the claim GET; components not mounted; door route 404s).',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

-- Verify:
-- SELECT flag_key, enabled, target_type, config FROM feature_flag_rules WHERE flag_key = 'case_rail_v1';
-- Expect: 1 row, enabled = false, target_type = 'global', config = {}.
