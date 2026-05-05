-- Migration 071: Out-of-network cost-sharing columns on canonical_plan_services.
-- CF-19c (Phase 5 F8 work brought forward into Session 64 per Q-S64-1).
--
-- Closes the architectural gap: canonical_plan_services was designed without OON
-- cost-sharing columns (only `copay`, `coinsurance`, `deductible_applies` for in-
-- network). When smart-skip copies canonical → user's plan_covered_services rows,
-- OON values land null because canonical doesn't carry them. This is visible on the
-- /plan page as empty out-of-network cells on every benefit row.
--
-- This migration adds the symmetric OON columns + extends the field_provenance
-- writeback path. SBC parser already extracts OON from common-medical-events
-- (legacy SBCParsedService.outCopay/outCoinsurance/outDeductibleApplies); we just
-- weren't persisting it on canonical because the columns didn't exist.
--
-- Pattern compliance:
--   - Pattern 1 #14: canonical population still gated by Pattern 1 #3 promotion
--     event (Phase 4.0.6 mig 068 mechanism). This migration is schema-only;
--     it does NOT change WHO writes to canonical, only WHAT columns are available.
--   - CLAUDE.md Rule #7 (additive only): all changes are ADD COLUMN; nothing dropped.
--   - Pattern P-8: OON values get the same field_provenance JSONB treatment
--     as IN-network values (one entry per column, source_excerpt + verifier
--     sub-keys when Haiku-extracted).
--
-- Cross-table symmetry: plan_covered_services already has out_copay/out_coinsurance/
-- out_deductible_applies/out_cost_description (legacy SBC schema). canonical was the
-- asymmetric outlier.

ALTER TABLE canonical_plan_services
  ADD COLUMN IF NOT EXISTS out_copay NUMERIC,
  ADD COLUMN IF NOT EXISTS out_coinsurance NUMERIC,
  ADD COLUMN IF NOT EXISTS out_deductible_applies BOOLEAN;

COMMENT ON COLUMN canonical_plan_services.out_copay IS
  'Out-of-network copay (USD). CF-19c — Session 64. Sourced via SBC common-medical-events extraction; null until Pattern 1 #3 corroboration promotes user-row data to canonical via mig 068 apply_promotion_event mechanism.';

COMMENT ON COLUMN canonical_plan_services.out_coinsurance IS
  'Out-of-network coinsurance (decimal 0-1, e.g., 0.4 = 40%). CF-19c — Session 64. Same provenance semantics as out_copay.';

COMMENT ON COLUMN canonical_plan_services.out_deductible_applies IS
  'Whether out-of-network deductible applies before this benefit pays. CF-19c — Session 64.';

-- No CHECK constraint, no trigger work — field_provenance JSONB already accommodates
-- these column names automatically (it's keyed by string column name; no enum).
-- Existing recompute_row_confidence_from_provenance trigger (mig 056) handles them
-- transparently when their entries are added to field_provenance.
