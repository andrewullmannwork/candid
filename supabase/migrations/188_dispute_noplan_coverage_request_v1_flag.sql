-- =============================================================================
-- MIGRATION 188 — dispute_noplan_coverage_request_v1 feature flag (S242, D3)
-- =============================================================================
--
-- Seeds the `dispute_noplan_coverage_request_v1` row in `feature_flag_rules` so the
-- no-plan coverage-ask reframe can be flipped global ON post-deploy without a code
-- change. Default OFF so the PR merges + deploys byte-identical (golden corpus 48/48
-- + letter-recovery prove OFF == today).
--
-- WHAT IT GATES (src/lib/disputes/templates.ts buildRequestSection):
--   When a dispute letter has plan-coverage grounds but NO plan on file to cite (no
--   coverage line carries a planBenefit), today's letter still ASSERTS coverage —
--   "Cover these services under the plan terms cited above" / "under my plan's
--   coverage" — with nothing cited. That violates the Evidence Disclosure Rule
--   (never assert what we can't back), in a legal artifact. This was LIVE (the
--   coverage ask was never flag-gated), not flag-on-only.
--   When ON, the coverage ask is REFRAMED (counsel-approved) from an assertion to a
--   REQUEST: compel the insurer to state the specific plan provision + clinical
--   criteria, produce the plan document (SPD/EOC) + the line-by-line adjudication,
--   and conduct a full-and-fair review; ask the provider to hold collections pending
--   the insurer's determination. The bill-side asks (duplicate, not-rendered,
--   balance-billing, coding) are UNTOUCHED — they don't need a plan. Also makes the
--   "missing per-line breakdown" tail recipient-correct (insurer → claim adjudication
--   / EOB; provider → itemized charges).
--   OFF -> byte-identical to today's letters (asserting copy + provider-shaped tail).
--   Symmetric across generate + rerender (the two letter paths can't diverge).
--   The user can still upload/search their plan (missingPlanForYear → PlanSearchModal)
--   to regenerate a plan-BACKED letter (the asserting copy returns, now legitimate).
--
-- ROLLOUT (ONE flip; copy is counsel-approved):
--   1. Merge with default OFF.
--   2. Deploy code (flag OFF -> reframe dormant, byte-identical).
--   3. Flip global ON (Andrew-approved "flip when complete"):
--        UPDATE feature_flag_rules SET enabled=true WHERE flag_key='dispute_noplan_coverage_request_v1';
--
-- ROLLBACK:
--   Flip OFF — the coverage ask reverts to today's copy (no-op). Row removal forbidden
--   (the gate reads the flag; a missing row is treated as OFF, but keep the row for
--   auditability). No schema change; additive seed only.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'dispute_noplan_coverage_request_v1',
  false,
  'S242 D3. When a dispute letter has plan-coverage grounds but no plan on file to cite, reframe the coverage ask (templates.ts buildRequestSection) from an unbacked ASSERTION ("cover under the plan terms cited above" / "under my plan''s coverage") to a counsel-approved REQUEST: compel the insurer to state the specific plan provision + clinical criteria, produce the plan document (SPD/EOC) + line-by-line adjudication, and conduct a full-and-fair review; ask the provider to hold collections pending the determination. Recipient-correct breakdown tail (insurer EOB vs provider itemized). Bill-side asks (duplicate/not-rendered/balance-billing/coding) untouched. OFF = byte-identical. Symmetric across generate + rerender. Fixes a LIVE Evidence-Disclosure violation (the coverage ask was never flag-gated).',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
