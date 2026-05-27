-- 132: normalize billing-field signs (bandaid for parser sign-convention bug).
--
-- Why: Haiku bill parser stored `insurance_adjusted_amount` + `insurance_paid`
-- (and their claim-header totals) with NEGATIVE signs on at least one PROD bill
-- (Dec 12 2022 Swedish, claim_id f2c36497-525c-46df-9509-eabc5e94398d). Per the
-- parser prompt contract at `src/lib/billing/haiku-bill-parser.ts:102` those
-- fields are positive magnitudes (writeoffs and payments are non-negative).
--
-- The negative-sign cascade inflates downstream math:
--   - BillCard "You were billed $1,247.52" when total_billed is $811
--     (= max(0, 811 - (-436.52)) inflates by abs(adjustment))
--   - BILL SHOWS "Insurer should have paid $621.04" when billed is $403
--   - Audit finding body text exposes nonsense ("$-218.04 writeoff")
--
-- Root-cause parser fix is a backend follow-up (see
-- plans/findings/parser_sign_hardening_followup.md). This migration is a
-- bandaid: flip existing PROD rows to positive so downstream math returns to
-- the right answers immediately. A persist.ts Math.abs guard added in the same
-- PR catches new writes until the parser fix lands.
--
-- ROLLOUT: 2 idempotent UPDATEs (re-running is safe — abs(positive)=positive).
-- BACKOUT: none. Original negative values were the bug.

BEGIN;

-- Per-line columns. WHERE clause makes this idempotent and avoids touching
-- legitimate zeros / positives.
UPDATE claim_line_items
SET insurance_adjusted_amount = abs(insurance_adjusted_amount),
    insurance_paid = abs(insurance_paid)
WHERE insurance_adjusted_amount < 0 OR insurance_paid < 0;

-- Claim-header totals.
UPDATE claims
SET total_insurance_adjusted = abs(total_insurance_adjusted),
    total_insurance_paid = abs(total_insurance_paid)
WHERE total_insurance_adjusted < 0 OR total_insurance_paid < 0;

COMMIT;
