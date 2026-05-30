-- =============================================================================
-- MIGRATION 134 — Dispute Letter Overhaul Block A: rollout gate + strength config
-- =============================================================================
--
-- Seeds the two feature_flag_rules rows Block A introduces (frontend workstream;
-- plans/dispute_letter_overhaul.md §4/§6). Mirrors the mig 126 flag-seed shape.
--
-- WHY THIS MIGRATION EXISTS
--
-- Block A is the strength + data-trust foundation of the dispute-letter overhaul
-- arc. It needs two distinct flags with distinct jobs (deliberately NOT folded
-- into one row — a rollout switch and a calibration knob are different concerns):
--
--   1. dispute_letter_v3_design  — the ROLLOUT GATE for the whole v3 arc.
--      Default OFF. Gates the data-trust HARD STOP behavior (suppress dispute
--      generation for a bill that failed header reconciliation) in Block A, and
--      the full reskin in Block C. Staged rollout (admin → 5% → 25% → 50% →
--      100%) happens in Block F. While OFF, behavior is today's status quo:
--      letters generate regardless of reconciliation state.
--
--   2. dispute_strength_config   — the CALIBRATION CONFIG for computeDisputeStrength.
--      Default ON, sole job is to carry the tunable weights + band thresholds
--      JSONB (Ship Gate G6 — no hardcoded constants; tune with no code deploy).
--      Mirrors the candidate_suggestions_config pattern (mig 127). The values
--      below are the §1e starting calibration; DO NOT over-tune pre-data
--      (calibrate post-launch from outcome priors). loadStrengthConfig() reads
--      this row regardless of enabled state and falls back to code defaults
--      per-field, so a missing row / partial config never weakens the model.
--
-- WHAT THIS MIGRATION ADDS
--
--   feature_flag_rules:
--     dispute_letter_v3_design  enabled=false target_type=global config={}
--     dispute_strength_config   enabled=true  target_type=global config={§1e weights+thresholds}
--
-- BEHAVIOR
--
--   dispute_letter_v3_design OFF (default): generate + [disputeId] GET + redraft
--     all behave as today — strength is still computed + surfaced in the payload
--     (additive; ungated; G7 fire/non-fire telemetry) but the HARD STOP never
--     suppresses a letter.
--   dispute_letter_v3_design ON: a header_reconciliation_failed bill suppresses
--     letter generation (generate returns 200 + blocked reason; GET serves
--     letterContent=null) so the UI surfaces the "we're checking this bill"
--     banner. Defense-in-depth enforced in BOTH generateDisputeLetter and
--     rerenderDisputeLetter (legal L3 — the gate is a shield).
--
--   dispute_strength_config weights/thresholds tunable in PROD via:
--     UPDATE feature_flag_rules
--       SET config = jsonb_set(config, '{thresholds,wellSupported}', '0.7')
--       WHERE flag_key = 'dispute_strength_config';
--     (no code deploy needed.)
--
-- BACKOUT — flag rows only; DELETE the rows to remove. With dispute_letter_v3_design
-- absent, isFeatureEnabled returns false (HARD STOP never enforced → status quo).
-- With dispute_strength_config absent, loadStrengthConfig falls back to the §1e
-- code defaults. Both safe.

BEGIN;

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'dispute_letter_v3_design',
  false,
  'Dispute Letter Overhaul Block A/C (S146). Rollout gate for the v3 dispute-letter arc. Default OFF. When ON, enforces the data-trust HARD STOP (suppress dispute generation for header_reconciliation_failed bills) across generate + [disputeId] GET + redraft, and (Block C) gates the dispute-letter reskin. Staged rollout admin → 5% → 25% → 50% → global in Block F. OFF preserves today''s behavior (letters generate regardless of reconciliation state; strength still computed + surfaced additively). See plans/dispute_letter_overhaul.md §1a/§6.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'dispute_strength_config',
  true,
  'Dispute Letter Overhaul Block A (S146). Carries the tunable weights + band thresholds for computeDisputeStrength (Ship Gate G6 — no hardcoded constants). Default ON; sole job is the config JSONB. loadStrengthConfig() reads this row regardless of enabled state and falls back per-field to the §1e code defaults. Values below are the §1e starting calibration — DO NOT over-tune pre-data; calibrate post-launch from outcome priors. Mirrors candidate_suggestions_config (mig 127). See plans/dispute_letter_overhaul.md §1e.',
  'global',
  '{
    "weights": {
      "probativeTier": { "documentary": 1.0, "statistical": 0.6, "inferred": 0.4 },
      "citeGradeFactor": { "verbatim": 1.0, "header": 0.7, "statute": 0.5 },
      "categoryWeight": { "spine": 1.0, "boost": 0.5, "benchmark": 0.4 }
    },
    "thresholds": { "partiallySupported": 0.34, "wellSupported": 0.67 }
  }'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
