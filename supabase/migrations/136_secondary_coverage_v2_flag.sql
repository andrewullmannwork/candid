-- =============================================================================
-- MIGRATION 136 — Secondary-coverage match v2: home/detail consistency + gate
-- =============================================================================
--
-- Seeds the single feature_flag_rules row that gates the S154 secondary-coverage
-- work (backend workstream). Mirrors the mig 134 flag-seed shape.
--
-- WHY THIS MIGRATION EXISTS
--
-- S153 shipped resolveSecondaryCoverage (annual_physical → preventive_care $0)
-- but wired it ONLY into the bill DETAIL GET, so the home/dashboard + claims
-- LIST still read "Unknown"/"needs review" for the same line the detail page
-- showed "Covered". S154 resolves coverage from ONE shared resolver across the
-- LIST + DETAIL (read-time), and adds a confidence GATE so a low-confidence
-- borrow surfaces a "Verify coverage" affordance instead of asserting silently.
--
-- This flag is the kill-switch for that whole behavior on BOTH surfaces, so the
-- two can never drift: a single source of truth for "is secondary matching on".
--
-- WHAT THIS MIGRATION ADDS
--
--   feature_flag_rules:
--     secondary_coverage_v2  enabled=true  target_type=global
--       config = { gate thresholds }
--
-- BEHAVIOR
--
--   ON (default): LIST + DETAIL apply the gated secondary match. A line whose
--     exact slug has no plan_covered_services row resolves via (1) a same-
--     category covered sibling or (2) the confirmed-ACA-preventive $0 backstop;
--     the gate marks each result `confident` (assert covered, no action) or
--     `estimate` (covered, but the UI shows a Verify-coverage affordance and the
--     dispute pipeline demotes it below cite-grade until the user confirms).
--   OFF: pre-S153 behavior on BOTH surfaces — exact-slug + ACA fallback only;
--     unmatched lines read "Unknown". Clean, consistent kill-switch (no
--     detail/list split). Emergency revert:
--       UPDATE feature_flag_rules SET enabled = false
--         WHERE flag_key = 'secondary_coverage_v2';
--
--   GATE THRESHOLDS (Ship Gate G6 — tunable with no code deploy via the config
--   JSONB; loadSecondaryGate() reads them with per-field fallback to the code
--   defaults in coverage-loader.ts):
--     trigramFloor          0.5   — min trigram sim for an "unambiguous identity"
--                                    confident category-sibling match
--     trigramMargin         0.15  — best candidate must beat the runner-up by this
--     homogeneityTolerance  0.01  — max copay-$ / coinsurance-fraction spread for
--                                    a category to count as homogeneous (→ confident)
--   Tune e.g. via:
--     UPDATE feature_flag_rules
--       SET config = jsonb_set(config, '{trigramFloor}', '0.6')
--       WHERE flag_key = 'secondary_coverage_v2';
--
-- BACKOUT — flag row only; DELETE the row to remove. With secondary_coverage_v2
-- absent, isFeatureEnabled returns false → both surfaces fall back to exact-slug
-- + ACA fallback (pre-S153), and loadSecondaryGate returns the code defaults.

BEGIN;

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'secondary_coverage_v2',
  true,
  'Secondary-coverage match v2 (S154). Gates the shared, gated secondary (category) coverage match across the claims LIST + bill DETAIL so home/dashboard agree with the detail page (fixes the S153 detail-only split). When ON, an exact-slug miss resolves via a same-category covered sibling or the confirmed-ACA-preventive $0 backstop; the confidence gate marks results confident (assert) or estimate (covered + Verify-coverage affordance + dispute demotion until confirmed). OFF = pre-S153 (exact-slug + ACA fallback only) on BOTH surfaces — clean kill-switch. Gate thresholds tunable via config JSONB (Ship Gate G6). See progress_backend.md S154.',
  'global',
  '{
    "trigramFloor": 0.5,
    "trigramMargin": 0.15,
    "homogeneityTolerance": 0.01
  }'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
