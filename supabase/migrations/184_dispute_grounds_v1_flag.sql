-- =============================================================================
-- MIGRATION 184 — dispute_grounds_v1 feature flag (S231)
-- =============================================================================
--
-- Seeds the `dispute_grounds_v1` row in `feature_flag_rules` so the §18
-- recovery-engine unification can be flipped global ON post-deploy without a
-- code change. Default OFF so the PR merges + deploys byte-identical (the golden
-- corpus proves OFF == today, 30/30), and the flip waits until the letter is
-- LEGALLY ROBUST (see ROLLOUT) — not merely "the $0.00 is gone".
--
-- WHAT IT GATES (§18.10 build arc; src/lib/disputes/*):
--   generate + rerender render the dispute letter from the unified
--   `buildDisputeGrounds(evidence)` model (durable, reconstructed every resolve)
--   instead of the legacy ephemeral `report.findings` param. This:
--     * structurally kills the $0.00 refresh bug — rerender passed findings:[]
--       so the overcharge/duplicate/balance_billing headline total + itemized
--       block zeroed; insurance_appeal was safe (it already reads `evidence`);
--     * sources the dollar from the deductible-AWARE computeCostShareV2 cap
--       (Call A) instead of the deductible-BLIND discrepancyAmount, so the
--       letter stops demanding money the patient legitimately owes (the
--       self-discrediting failure mode against an insurer, who computes the
--       deductible);
--     * applies the Evidence Disclosure Rule per element (assert / provide+
--       confirm / demand / request / omit) + the §19 in-letter demands
--       (itemized specificity; contracted-rate apply + disclose).
--   OFF -> byte-identical to today's letters (golden corpus 30/30).
--   ORTHOGONAL to dispute_letter_v3_design (NOT nested / superseded).
--   Precondition: recovery_cost_share_v2 ON (already ON in PROD) — the
--   cost-share engine the cap routes through + letter-version safety net.
--
-- ROLLOUT (ONE flip, only when LEGALLY ROBUST):
--   1. Merge with default OFF.
--   2. Deploy code (flag OFF -> grounds path dormant, byte-identical).
--   3. Flip global ON ONLY after the insurer-path letter is deductible-aware +
--      carries the §19 demands + Andrew letter co-review for legal viability,
--      validated by a real flag-ON PROD oracle E2E:
--        UPDATE feature_flag_rules SET enabled=true WHERE flag_key='dispute_grounds_v1';
--
-- ROLLBACK:
--   Flip OFF — letters revert to the legacy path (no-op). Row removal forbidden
--   per Pattern 1 #10 hard-delete prohibition.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'dispute_grounds_v1',
  false,
  'S231 §18. Renders the dispute letter from the unified buildDisputeGrounds(evidence) model (durable, reconstructed every resolve) instead of the ephemeral report.findings param. Structurally kills the $0.00 refresh bug (rerender passed findings:[] -> overcharge/duplicate/balance_billing zeroed; insurance_appeal was safe). Sources the dollar from the deductible-AWARE computeCostShareV2 cap (Call A) not the deductible-BLIND discrepancyAmount, so the letter stops demanding money the patient legitimately owes. Applies the Evidence Disclosure Rule per element + the §19 in-letter demands (itemized specificity; contracted-rate apply + disclose). OFF = byte-identical (golden corpus 30/30). Orthogonal to dispute_letter_v3_design. Precondition recovery_cost_share_v2 ON. Flip global ON ONCE, only after the insurer letter is deductible-aware + §19-complete + Andrew legal co-review + a real flag-ON PROD oracle E2E.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
