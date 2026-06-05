-- =============================================================================
-- MIGRATION 152 — Thesaurus: retire hospital_outpatient (ABSORB) + fill the
--                 outpatient-surgery slug descriptions (S169)
-- =============================================================================
--
-- WHY
--
-- hospital_outpatient is a NET-NEGATIVE catalog slug. Across Andrew's 372 hand
-- adjudications it is NEVER the correct answer (0 oracle entries; 0 in any
-- acceptableSlugs), 0 canonical_plan_services rows reference it, yet the resolver
-- maps 51 services to it (S169 after-run) — ALL errors: 46 belong to
-- outpatient_surgery_facility / outpatient_surgery_physician, 4 are genuinely
-- no-concept, 1 is inpatient_facility. Its description
-- ("Outpatient hospital services / facility fee") over-matches outpatient-SURGERY
-- facility-fee text and steals it from the surgery slugs (S168 audit pattern ②).
--
-- The full Pattern S re-map (surgery = pure-service + place_of_service + component;
-- Hard Rule #17) is Phase 1. mig 152 is the targeted ② fix.
--
-- DECISION (Andrew, S169): ABSORB, not narrow — remove the error source rather
-- than re-word a slug that is never correct. Paired with a one-line resolver
-- change (loadCatalogRich now also filters `deprecated_at IS NULL`) so a retired-
-- but-unmerged slug drops out of the candidate set. (Verified safe: all 14
-- currently-deprecated slugs are already merged → already excluded; zero side
-- effects until this row is retired.)
--
-- WHAT
--   1. Retire hospital_outpatient: deprecated_at = now() (deprecate-not-drop,
--      Rule #7 — the row stays for provenance + reversibility). NO merged_into_id:
--      it disperses to multiple targets, so it is RETIRED, not merged.
--   2. Fill the two empty outpatient_surgery_* descriptions so the 46 surgery
--      lines route to them (facility vs physician) once hospital_outpatient is gone.
--
-- VALIDATION: the routing improvement is proven by the Step-4 resolver re-run
-- (B2-vs-oracle, N-run majority) — NOT asserted here. mig 152 is the hypothesis.
--
-- ROLLBACK:
--   UPDATE service_catalog SET deprecated_at = NULL WHERE slug = 'hospital_outpatient';
--   UPDATE service_catalog SET description = '' WHERE slug IN
--     ('outpatient_surgery_facility','outpatient_surgery_physician');
--   (and revert the loadCatalogRich one-liner)
--
-- Data-only UPDATEs (no schema change) — same shape as mig 150 catalog corrections.

BEGIN;

-- 1. Retire the net-negative slug (resolver now honors deprecated_at via loadCatalogRich).
UPDATE service_catalog
   SET deprecated_at = now(), updated_at = now()
 WHERE slug = 'hospital_outpatient'
   AND deprecated_at IS NULL;

-- 2. Give the outpatient-surgery slugs real descriptions so the freed-up surgery
--    lines route correctly (they were empty → matched on name only).
UPDATE service_catalog
   SET description = 'Facility fee for surgery performed in an outpatient / ambulatory setting (ambulatory surgery center or hospital outpatient surgery department).',
       updated_at = now()
 WHERE slug = 'outpatient_surgery_facility';

UPDATE service_catalog
   SET description = 'Physician / surgeon professional fee for surgery performed in an outpatient / ambulatory setting.',
       updated_at = now()
 WHERE slug = 'outpatient_surgery_physician';

COMMIT;
