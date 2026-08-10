-- 227 — seed the savings_math_derivation_v1 flag (OFF, global).
--
-- S307. The "what you could save" panel explains itself: the plan card leads
-- with the plan's PRICED answer ("$0.00 — owed on the lines your plan prices
-- today (1 of 2)") with per-line plan answers and a Confirm-your-rate ask on
-- unpriced lines (the existing AddPlanDetailsModal); a "Where these numbers
-- come from" strip connects the two cards to the Refund / Provider-must-forgive
-- totals per line; the recovery banner's tense is corrected ("refund to
-- request" — nothing has been refunded yet). All rendering — the engine's
-- per-line results are displayed, never recomputed.
--
-- OFF (default, and the missing-row fail-closed state) = today's panel,
-- byte-identical.
--
-- Rollback: DELETE FROM feature_flag_rules WHERE flag_key = 'savings_math_derivation_v1';

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'savings_math_derivation_v1',
  false,
  'S307 (2026-08-10). Savings-math derivation — the "what you could save" panel explains itself. ON: the plan card leads with the priced answer (shouldOwe summed over rate-known lines, labeled with the count) + per-line plan answers + Confirm-your-rate on unpriced lines (existing AddPlanDetailsModal); a "Where these numbers come from" strip shows per-line You-paid → plan-says → You''re-Owed/Off-your-balance, with the spread sentence only when amounts are header-prorated; banner tense fix (refund to request / to remove from your balance); Refund+Forgive sublabels. Display-only — the engine''s per-line results are rendered, never recomputed. OFF = today''s panel byte-identical.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
