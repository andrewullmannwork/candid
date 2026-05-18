-- =============================================================================
-- MIGRATION 106 — Bill parser hardening feature flags (S94 B4)
-- =============================================================================
--
-- Seeds three flag rows for the bill parser robustness layer added in
-- response to S94 B1 Stage 4 testing finding (2026-05-15): user uploaded an
-- SBC as "Bill" via the document picker; the bill parser hallucinated 5
-- line items with fake CPT codes (10348, 21244, 20201, 51330) extracted
-- from P.O. Box numbers, ZIP codes, and phone numbers; reported $93k
-- patient responsibility from coverage-example math; emitted 2 actionable
-- audit findings including one with $NaN amounts.
--
-- FLAGS:
--   bill_parser_sbc_marker_scan
--     Refuses parseBillWithHaiku + parseBillFromOCR when ≥2 SBC fingerprint
--     markers match the OCR text (Summary of Benefits and Coverage, What
--     this Plan Covers, Common Medical Event, etc.). Returns null /
--     empty-line ParsedBill with parseError "rejected_sbc_in_bill_parser".
--     Catches SBC-as-bill mis-routing where the doc-type resolver fails.
--
--   bill_parser_nan_guard
--     In runAudit, drops findings where estimatedOvercharge or billedAmount
--     is non-finite (NaN/Infinity). Prevents "$NaN" findings from rendering
--     as actionable.
--
--   bill_parser_arithmetic_check
--     After Haiku extraction, drops line items violating physical
--     plausibility: (a) billed=$0 with $5k+ paid or owed, (b)
--     insurance_paid > 10x billed, (c) patient_responsibility > 20x billed.
--     Catches hallucinations from boilerplate text. Conservative
--     thresholds; defer aggressive enforcement to follow-up.
--
-- ROLLOUT:
--   All three default OFF. Andrew flips ON in PROD after local Chrome MCP
--   verification (upload SBC → expect rejection; upload real EOB → expect
--   normal extraction).
--
-- ROLLBACK:
--   Per-flag flip OFF — surfaces are independent (different files) so a
--   single regression isolates cleanly. Removal of rows forbidden per
--   Pattern 1 #10 hard-delete prohibition.
--
-- COMPANION:
--   Doc-type resolver hardening (s94-b5) addresses the misrouting upstream;
--   this PR is parser-side defense-in-depth for the case where the
--   resolver fails or is bypassed.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES
  (
    'bill_parser_sbc_marker_scan',
    false,
    'S94 B4. Refuses bill parsing (parseBillWithHaiku + parseBillFromOCR) when the OCR text matches >=2 SBC fingerprint markers (Summary of Benefits and Coverage title, Common Medical Event table header, About these Coverage Examples header, etc.). Returns null / empty-line ParsedBill with parseError rejected_sbc_in_bill_parser. Catches SBC-as-bill mis-routing where the doc-type resolver (s94-b5) fails or is bypassed. Default OFF; flip ON post-deploy after local Chrome MCP verification.',
    'global',
    '{}'::jsonb
  ),
  (
    'bill_parser_nan_guard',
    false,
    'S94 B4. In runAudit, drops findings where estimatedOvercharge or billedAmount is non-finite (NaN / Infinity). Prevents "$NaN" findings from rendering as actionable. Pre-fix, NaN could leak through claim-header-arithmetic.ts:69 (unallocated calculation) and rules.ts checkDuplicates / checkMissingAdjustments when source values were undefined-coerced-to-number. Default OFF.',
    'global',
    '{}'::jsonb
  ),
  (
    'bill_parser_arithmetic_check',
    false,
    'S94 B4. After Haiku extraction in parseBillWithHaiku, drops line items that violate physical plausibility: (a) billed=0 with $5k+ paid or owed, (b) insurance_paid > 10x billed, (c) patient_responsibility > 20x billed. Catches hallucinations from boilerplate text (zip codes mistaken for CPTs, P.O. boxes mistaken for amounts, etc.). Conservative thresholds intentionally to avoid false-positives on legitimate edge cases (capitated visits, secondary payer, interest lines). Default OFF.',
    'global',
    '{}'::jsonb
  )
ON CONFLICT (flag_key) DO NOTHING;
