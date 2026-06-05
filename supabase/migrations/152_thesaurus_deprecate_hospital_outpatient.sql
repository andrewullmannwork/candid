-- =============================================================================
-- MIGRATION 152 — Thesaurus: retire hospital_outpatient (ABSORB) (S169)
-- =============================================================================
--
-- WHY
--
-- hospital_outpatient is a NET-NEGATIVE catalog slug. Across Andrew's 372 hand
-- adjudications it is NEVER the correct answer (0 oracle entries; 0 in any
-- acceptableSlugs), 0 canonical_plan_services rows reference it, yet the resolver
-- maps 51 services to it (S169 after-run) — ALL errors. Its description
-- ("Outpatient hospital services / facility fee") over-matches outpatient-SURGERY
-- facility-fee text and steals it from the live `surgery` pure-service slug
-- (S168 audit pattern ②). The oracle's correct answer for those 46 is `surgery`
-- — the old outpatient_surgery_facility/physician slugs are ALREADY merged into
-- `surgery` (mig 148), so they are not live resolver targets and there is nothing
-- to "fill" on them; the S169 draft's part 2 was inert and is dropped here.
--
-- The full Pattern S re-map (surgery = pure-service + place_of_service + component;
-- Hard Rule #17) is Phase 1. mig 152 is the targeted ② fix: remove the error source.
--
-- DECISION (Andrew, S169): ABSORB, not narrow — remove a slug that is never correct.
-- Paired with the resolver change (loadCatalogRich now also filters
-- `deprecated_at IS NULL`) so a retired-but-unmerged slug drops out of the candidate
-- set. Verified safe: 0 orphan-deprecated slugs in PROD (every deprecated slug is
-- also merged → already excluded), so this filter only bites hospital_outpatient.
--
-- WHAT
--   1. Retire hospital_outpatient: deprecated_at = now() (deprecate-not-drop,
--      Rule #7 — row stays for provenance + reversibility). NO merged_into_id:
--      it disperses to multiple targets, so it is RETIRED, not merged.
--
-- VALIDATION: the routing improvement (46 → `surgery`) is proven by the Step-4
-- resolver re-run (B2-vs-oracle, N-run majority) — NOT asserted here.
--
-- ROLLBACK:
--   UPDATE service_catalog SET deprecated_at = NULL WHERE slug = 'hospital_outpatient';
--   (and revert the loadCatalogRich one-liner)
--
-- Data-only UPDATE (no schema change) — same shape as mig 150 catalog corrections.

BEGIN;

-- Retire the net-negative slug (resolver now honors deprecated_at via loadCatalogRich).
UPDATE service_catalog
   SET deprecated_at = now(), updated_at = now()
 WHERE slug = 'hospital_outpatient'
   AND deprecated_at IS NULL;

COMMIT;
