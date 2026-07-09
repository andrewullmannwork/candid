-- Migration 201 — plan_covered_services.annual_limit_value: INTEGER → NUMERIC
--
-- ROOT CAUSE (S273): the extractor writes DOLLAR caps into annualLimitValue (per the parser prompt —
-- "dollar caps stay in annualLimitValue"; a per-visit/day COUNT goes in visit_limit). Real example:
-- an $38.50 children's-eye-exam allowance → annualLimitValue = 38.5. But this column was INTEGER
-- (mig 009), so a decimal fails the plan_covered_services INSERT with 22P02
-- ("invalid input syntax for type integer: 38.5"). The WHOLE services batch aborts → 0 services
-- persisted → the plan cannot regenerate. SHARED-PATH PRODUCTION bug: any live upload with a
-- decimal-dollar annual cap fails identically (11 cold-start plans surfaced it: same $38.50 vision template).
--
-- FIX: widen to NUMERIC (dollar caps can carry cents). in_copay / out_copay / in_coinsurance are already
-- NUMERIC on this table and promote correctly through the SAME pcs → expandPerServiceCandidates →
-- apply_promotion_event path (RPC arm gates on jsonb_typeof='number'), so annual_limit_value NUMERIC
-- behaves identically — NO consumer/code change required.
--
-- Rule #7 (additive/non-breaking): INTEGER → NUMERIC is a WIDENING. Every existing integer value stays
-- valid; no data loss; reads unaffected.
--
-- FOLLOW-UP (documented, non-blocking): canonical_plan_services.annual_limit stays INTEGER and
-- apply_promotion_event coerces via ::INTEGER, so a promoted canonical dollar-cap truncates to whole
-- dollars ($38.50 → $38) and the provenance value≠column reads as a NON-GATING §14 "ambiguous" row.
-- Preserving canonical cents needs a redefinition of the shared apply_promotion_event RPC (hot-path;
-- the dispute lane also calls it) — deferred to a deliberate follow-up. §14 HARD gates (percent-coins /
-- missing-value / stranded) are unaffected by this migration.
--
-- ROLLBACK: ALTER TABLE plan_covered_services ALTER COLUMN annual_limit_value TYPE INTEGER
--           USING round(annual_limit_value)::INTEGER;   -- (lossy: re-truncates any cents written since)

ALTER TABLE plan_covered_services
  ALTER COLUMN annual_limit_value TYPE NUMERIC USING annual_limit_value::NUMERIC;

COMMENT ON COLUMN plan_covered_services.annual_limit_value IS
  'Numeric value of an annual limit. NUMERIC since mig 201 to hold DOLLAR caps that may include cents (e.g. $38.50 vision allowance). A per-visit/day COUNT cap goes in visit_limit (INTEGER). Was INTEGER (mig 009), which rejected decimal dollar caps with 22P02.';
