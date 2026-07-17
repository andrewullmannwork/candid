-- =============================================================================
-- MIGRATION 210 — accumulator feature flags (ledger + dispute-feed) (S283)
-- =============================================================================
--
-- TWO flags, both OFF (§11): `accumulator_ledger_v1` (Phases 1-2, compute + display)
-- and `accumulator_feeds_dispute_v1` (Phase 3, feeds the counsel-reviewed dispute
-- engine). Seeded together so Phase 3 needs no new migration; the display ships
-- (ledger flag) without ever touching disputes (dispute-feed flag stays OFF).
-- =============================================================================
--
-- Seeds the `accumulator_ledger_v1` row in `feature_flag_rules` so the deductible
-- & OOP-max accumulator (cross-bill running tally + Candid-vs-insurer divergence)
-- can be exposed without a code change. Default OFF so the PR merges + deploys
-- byte-identical: the loader short-circuits and `GET /api/plan/accumulators` omits
-- the ledger, so the /plan + dashboard panels stay hidden until flip.
--
-- WHAT IT GATES:
--   * GET /api/plan/accumulators — the endpoint that returns Candid's own running
--     deductible/OOP tally (threaded from the user's uploaded bills via the plan
--     terms, `src/lib/claims/accumulator-ledger.ts`) alongside the insurer's OWN
--     reported accumulator (`claim_accumulators`), with material, like-for-like,
--     adjudicated, non-lag divergences flagged (§9).
--   * The /plan spending panel + the dashboard summary that consume it.
--   OFF -> endpoint omits the field; UI hides the panel; zero behavior change.
--
-- CONFIG (admin-tunable materiality gate, §9 — read like loadCostShareGate):
--   materiality_dollars — a divergence smaller than this (absolute $) is treated
--                         as "matches" (never flagged). Default 25.
--   materiality_pct     — OR smaller than this fraction of the bucket's plan limit,
--                         whichever is larger. Default 0.02 (2%).
--   Tune live via the admin flag-config surface; no deploy needed. Never a
--   hardcoded call-site constant (Ship Gate G6).
--
-- ROLLOUT:
--   1. Merge with default OFF.
--   2. Deploy code (flag OFF -> endpoint + UI inert).
--   3. Flip global ON after a real flag-ON smoke on a parsed bill/EOB:
--        UPDATE feature_flag_rules SET enabled=true WHERE flag_key='accumulator_ledger_v1';
--
-- ROLLBACK:
--   Flip the flag OFF — endpoint reverts to omitting the ledger (no-op). Row
--   removal is forbidden per Pattern 1 #10 hard-delete prohibition.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'accumulator_ledger_v1',
  false,
  'S283. Deductible & OOP-max accumulator. When ON, GET /api/plan/accumulators returns Candid''s OWN cross-bill running deductible/OOP tally (threaded from the user''s uploaded bills through the plan terms) beside the insurer''s reported accumulator (claim_accumulators), flagging material, like-for-like, adjudicated, non-lag divergences (a plan-maintained accumulator running behind = deductible the user has already paid). Feeds the /plan spending panel + dashboard summary. User-scoped only (no canonical writes, no cross-user aggregation). OFF = endpoint omits the field + UI hides the panel = byte-identical. config.materiality_dollars / config.materiality_pct are the admin-tunable divergence-flag gate (default $25 / 2%).',
  'global',
  '{"materiality_dollars": 25, "materiality_pct": 0.02}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

-- Phase 3 (separate flag; OFF until the display is proven). When ON, Candid's
-- cross-bill accumulator feeds the per-claim cost-share engine (resolve-cost-share)
-- + the per-bill assumptions surface — parity-tested so the matched case (our tally
-- == the insurer's) leaves dispute dollars byte-identical. OFF = the dispute engine
-- reads each EOB's own snapshot exactly as today.
INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'accumulator_feeds_dispute_v1',
  false,
  'S283 (Phase 3). When ON, the cross-bill accumulator ledger (accumulator_ledger_v1) feeds the per-claim cost-share engine + the per-bill assumptions surface, so "should you owe this bill" uses Candid''s running deductible/OOP state instead of each EOB''s self-reported snapshot. Parity-guarded: when our tally matches the insurer''s, dispute dollars stay byte-identical. User-scoped. OFF = dispute engine unchanged (reads the per-claim EOB snapshot). Flip ON only after the display is validated + a matched-case parity smoke.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
