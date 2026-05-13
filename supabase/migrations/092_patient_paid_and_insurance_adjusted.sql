-- ============================================================================
-- Migration 092 — patient out-of-pocket + insurance contractual writeoff
-- ============================================================================
-- Closes the data gap surfaced when Bill 1 (claim ed471aa0) parser-mis-read
-- "Ins adjusted" as `insurance_paid`. The two are different concepts and
-- conflating them produces wrong audit findings + wrong recovery numbers.
--
-- Provider bill columns and where they land:
--   billed_amount            ← "Total billed"                                (existing)
--   insurance_adjusted_amount← "Ins adjusted" (contractual writeoff)         (NEW this mig)
--   insurance_paid           ← "Ins paid"     (insurer's actual payment)    (existing — parser fix in same PR)
--   patient_owes             ← "Amount due"   (total user share, pre-payment)(existing semantic)
--   patient_paid_amount      ← Σ "Paid [date] -$X"  (user OOP payments)     (NEW this mig)
--
-- Derived (no column needed):
--   remaining_balance = patient_owes − patient_paid_amount
--   allowed_amount    = billed_amount − insurance_adjusted_amount
--
-- Recovery math (post-fix, recovery-math.ts):
--   user_burden        = patient_owes
--   refund             = max(0, patient_paid_amount − should_owe)
--   forgiveness        = max(0, patient_owes − patient_paid_amount
--                                 − max(0, should_owe − patient_paid_amount))
--   potentialRecovery  = refund + forgiveness = max(0, patient_owes − should_owe)
--
-- Both columns DEFAULT 0 — legacy rows get 0 for both. The accompanying
-- backfill script (scripts/backfill-providence-bills.ts) corrects the two
-- Andrew test claims to actual values from their source PDFs.
--
-- Additive only. Safe to re-run.
-- ============================================================================

ALTER TABLE claim_line_items
  ADD COLUMN IF NOT EXISTS patient_paid_amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS insurance_adjusted_amount NUMERIC DEFAULT 0;

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS total_patient_paid NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_insurance_adjusted NUMERIC DEFAULT 0;

-- Fast filter for "bills the user has already paid in full" (refund-class disputes)
CREATE INDEX IF NOT EXISTS idx_claim_line_items_patient_paid
  ON claim_line_items(claim_id)
  WHERE patient_paid_amount IS NOT NULL AND patient_paid_amount > 0;

COMMENT ON COLUMN claim_line_items.patient_paid_amount IS
  'How much the patient has paid out of pocket on this line. Distinct from patient_owes (= total responsibility assigned by insurer). Default 0 for legacy rows. Parser populates from "Paid [date] -$X" entries on the bill PDF.';
COMMENT ON COLUMN claim_line_items.insurance_adjusted_amount IS
  'Contractual writeoff applied by the insurer ("Ins adjusted" line on Providence-style bills). Distinct from insurance_paid (= insurer''s actual payment to the provider). billed_amount − insurance_adjusted_amount = allowed_amount.';
COMMENT ON COLUMN claims.total_patient_paid IS
  'Claim-header sum of patient out-of-pocket payments. Derived from line items or extracted from EOB footer.';
COMMENT ON COLUMN claims.total_insurance_adjusted IS
  'Claim-header sum of contractual writeoffs. From EOB "Ins adjusted" total line.';
