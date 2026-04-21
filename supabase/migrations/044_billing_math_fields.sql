-- Session 35: Billing math + dispute recovery fields
--
-- Disambiguates what today's `patient_owes` conflates. New columns are
-- strictly additive — `patient_owes` and `total_patient_responsibility`
-- remain valid for backwards compat and continue to be written.
--
-- Data model:
--   billed_amount = provider's charge (unchanged)
--   amount_still_outstanding = what the provider says is still due
--   amount_resolved = billed_amount - amount_still_outstanding
--     (combines insurance payments + adjustments + past patient payments;
--      exposed to users as "Already Paid" per their mental model)
--
-- The reconciler library (T2.8 Session 36) populates these from Haiku
-- output on ingest. Until then, the /api/claims route derives them from
-- existing data using a pro-rate fallback keyed on billed_amount share.
-- ============================================================================

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS amount_still_outstanding NUMERIC,
  ADD COLUMN IF NOT EXISTS amount_resolved NUMERIC;

ALTER TABLE claim_line_items
  ADD COLUMN IF NOT EXISTS amount_still_outstanding NUMERIC,
  ADD COLUMN IF NOT EXISTS amount_resolved NUMERIC;

-- Fast filter for "bills with outstanding balance" (dispute targets)
CREATE INDEX IF NOT EXISTS idx_claims_still_outstanding
  ON claims(user_id)
  WHERE amount_still_outstanding IS NOT NULL AND amount_still_outstanding > 0;

-- Fast filter for line-level reconciliation / admin review
CREATE INDEX IF NOT EXISTS idx_claim_line_items_outstanding
  ON claim_line_items(claim_id)
  WHERE amount_still_outstanding IS NOT NULL;

COMMENT ON COLUMN claims.amount_still_outstanding IS
  'What the provider says is still due on this claim (from EOB header or reconciler pro-rate).';
COMMENT ON COLUMN claims.amount_resolved IS
  'billed − still_outstanding. Includes insurance, adjustments, past patient payments. Shown to users as "Already Paid".';
COMMENT ON COLUMN claim_line_items.amount_still_outstanding IS
  'Line-level still-outstanding amount. Null until the reconciler (T2.8 S36) populates or Haiku returns per-line allocation.';
COMMENT ON COLUMN claim_line_items.amount_resolved IS
  'Line-level billed − still_outstanding. Derivable at read time as pro-rate fallback.';
