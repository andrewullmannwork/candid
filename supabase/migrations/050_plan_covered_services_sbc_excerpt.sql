-- Migration 050: Plan coverage SBC direct-quote columns (Phase 4.5)
--
-- Adds `sbc_excerpt` + `sbc_page` to `plan_covered_services` so the dispute
-- letter / Case File evidence block can quote the SBC verbatim when citing
-- benefits. Example: "Your plan SBC states (page 3): 'Primary Care Visit to
-- Treat an Injury or Illness: $20 copay per visit, deductible does not apply.'"
--
-- Direct quotes make citations credible to insurance readers. The Haiku SBC
-- parser (Phase 4.5 follow-up) populates these fields on new extractions;
-- existing rows stay NULL and fall back to page-only citations. No backfill.
--
-- Additive, nullable, no DROPs.

ALTER TABLE plan_covered_services
  ADD COLUMN IF NOT EXISTS sbc_excerpt TEXT,
  ADD COLUMN IF NOT EXISTS sbc_page INTEGER;

COMMENT ON COLUMN plan_covered_services.sbc_excerpt IS
  'Verbatim SBC quote that Haiku used to derive the copay/coinsurance/coverage value. Rendered in dispute letter evidence block as a blockquote. Populated by Haiku SBC parser from Phase 4.5 onward. Legacy rows stay NULL and fall back to page-only citations.';
COMMENT ON COLUMN plan_covered_services.sbc_page IS
  'SBC page number where the excerpt was found. Displayed in citations ("Plan SBC, page 3"). Nullable for backward compatibility.';
