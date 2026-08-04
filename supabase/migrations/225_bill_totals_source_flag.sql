-- =============================================================================
-- MIGRATION 225 — Bill totals source v1 feature flag (S302)
-- =============================================================================
--
-- Seeds `bill_totals_source_v1` in `feature_flag_rules`. Gates the assumptions
-- row that asks the user which of OUR TWO PARSES to trust when a bill's line
-- items do not sum to the bill's own summary.
--
-- WHY IT EXISTS. A bill is internally consistent on paper. When our line-item
-- parse and our header parse disagree, one of OURS is wrong — and today the
-- product resolves it SILENTLY: resolveEffectiveClaimTotals' `decideField`
-- picks the header and records `provenance.<field>Source = "claim_header"`,
-- and every per-line consumer quietly switches to prorating that header by
-- billed share. Correct behaviour, never disclosed. Measured on DEV at S302:
-- 14 of 17 claims disagree on at least one total.
--
-- WHAT THE FLAG TURNS ON. One question, in the step-1 assumptions block where
-- every other correction already lives: "These numbers don't match — adding up
-- the line items gives $X for what you owe, but the bill's own summary says
-- $Y. Which is right?" with [Use the summary] / [Use the line items]. The
-- answer is stored on `claims.metadata.userTotalsSource` (Rule #9 JSONB-first,
-- re-parse-proof, mirroring `userPatientPaid`) and consulted by `decideField`.
--
-- ⚠ It records a CHOICE BETWEEN TWO ALREADY-PARSED NUMBERS — never a new
-- value. No per-line writes, no redistribution, no imputation. Choosing "the
-- line items" additionally makes the raw per-line values cite-grade
-- (isPerLineCiteGrade), which is exactly what the user just asserted.
--
-- REACH. `resolveEffectiveClaimTotals` has five production callers (claims
-- list, claim detail, dispute-ground-basis, evidence-resolver,
-- accumulator-loader). The answer is threaded as a REQUIRED parameter so the
-- compiler names every site: an optional one would let a caller silently keep
-- the old answer, and the claim page would show the corrected total while the
-- LETTER still cited the old one. The answer is also hashed into the evidence
-- fingerprint (`user_totals_src`), so a correction marks an existing draft
-- stale and the Refresh regenerates it.
--
-- FLYWHEEL. Each answer is a human telling us which of our two parses was
-- wrong — precision-oracle signal for parser calibration. Recorded on the case
-- ledger as `bill_totals_adjudicated` (vocabulary 19 → 20; no migration, mig
-- 221 shape-checks `kind` rather than enumerating it). Payload is `{ chose }`
-- only: which fields disagreed is derivable from the claim, and money amounts
-- are excluded on principle.
--
-- OFF = byte-identical: the row does not render, nothing writes the key, and
-- `decideField` sees a null answer and applies today's header-wins rule.
--
-- ROLLBACK: flip OFF (UPDATE feature_flag_rules SET enabled=false WHERE
-- flag_key='bill_totals_source_v1'). Any answer already stored stays in
-- metadata and simply stops being read — no data migration to unwind. To also
-- neutralize stored answers, clear the key; not required for rollback.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'bill_totals_source_v1',
  false,
  'S302 (2026-08-03). Bill totals source v1 — when a bill''s line items do not sum to its own summary, ask the user which of our two parses to trust, in the step-1 assumptions block. Stores the answer on claims.metadata.userTotalsSource (Rule #9 JSONB-first, re-parse-proof); decideField consults it and isPerLineCiteGrade makes raw per-line values citable when the user says the line items are right. Records a CHOICE between two already-parsed numbers — no per-line writes, no redistribution, no imputation. Threaded as a REQUIRED param through all five resolveEffectiveClaimTotals callers so no surface can keep a stale answer, and hashed into the evidence fingerprint so a correction marks drafts stale. Emits bill_totals_adjudicated on the case ledger (precision-oracle signal for parser calibration). OFF = byte-identical: no row, no writes, today''s header-wins rule.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

-- Verify:
-- SELECT flag_key, enabled, target_type, config FROM feature_flag_rules WHERE flag_key = 'bill_totals_source_v1';
-- Expect: 1 row, enabled = false, target_type = 'global', config = {}.
