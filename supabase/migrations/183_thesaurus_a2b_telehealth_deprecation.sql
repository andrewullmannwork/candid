-- =============================================================================
-- MIGRATION 183 — Thesaurus A2b Phase 2 item 4: deprecate telehealth_pcp /
-- telehealth_specialist (S231)
-- =============================================================================
--
-- WHY
--
-- "telehealth" is a PLACE, not a service (Hard Rule #17 / Pattern S). The two
-- telehealth slugs bake the delivery channel into the slug name, making them
-- indistinguishable from their in-person equivalents at the cost-share matching
-- layer (telehealth $0 vs office $30 would both resolve to a bare pcp_visit
-- without a place modifier).
--
-- Fix: merge each into its base service slug + carry place=virtual as a Pattern-S
-- modifier. The resolver (deriveModifiers, thesaurus_phase1a_v1 flag-gated) emits
-- place=virtual + component=global for telehealth cues. All 7 parser consumers
-- updated in the same commit.
--
-- WHAT
--   telehealth_pcp      → merged into pcp_visit       (place=virtual, component=global)
--   telehealth_specialist → merged into specialist_visit (place=virtual, component=global)
--
-- ADDITIVE / DEPRECATING (Rule #7): rows are NOT dropped. merged_into_id +
-- deprecated_at + merged_at mark them retired; the resolver already filters
-- `deprecated_at IS NULL` (S169 / service-resolver.ts loadCatalogRich).
-- Old stored canonical_plan_services rows with these slugs continue to work via
-- legacy aliases in the analyze route until cold-start regen (Group B) rewrites them.
--
-- ROLLBACK:
--   UPDATE service_catalog
--      SET merged_into_id = NULL, merged_at = NULL, deprecated_at = NULL, updated_at = now()
--    WHERE slug IN ('telehealth_pcp', 'telehealth_specialist');
--

BEGIN;

-- Deprecate telehealth_pcp → pcp_visit
UPDATE service_catalog
   SET merged_into_id = (SELECT id FROM service_catalog WHERE slug = 'pcp_visit'),
       merged_at      = now(),
       deprecated_at  = now(),
       updated_at     = now()
 WHERE slug = 'telehealth_pcp'
   AND deprecated_at IS NULL;

-- Deprecate telehealth_specialist → specialist_visit
UPDATE service_catalog
   SET merged_into_id = (SELECT id FROM service_catalog WHERE slug = 'specialist_visit'),
       merged_at      = now(),
       deprecated_at  = now(),
       updated_at     = now()
 WHERE slug = 'telehealth_specialist'
   AND deprecated_at IS NULL;

COMMIT;

-- VERIFY (run after applying; expect 2 rows, both with deprecated_at IS NOT NULL):
-- SELECT slug, deprecated_at, merged_at,
--        (SELECT slug FROM service_catalog t WHERE t.id = sc.merged_into_id) AS merged_into
--   FROM service_catalog sc
--  WHERE slug IN ('telehealth_pcp', 'telehealth_specialist');
