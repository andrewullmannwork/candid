-- Migration 112: Add specialty_rx_tier5 to service_catalog
--
-- Purpose: BCBS NC plans (and many other regional carriers' plans) split specialty
-- drug coverage into Preferred Specialty (Tier 4) AND Non-Preferred Specialty
-- (Tier 5). The S95 B1 service_catalog reset seeded only 68 canonical slugs
-- ending at specialty_rx_tier4. S104 admin cold-start surfaced 3 BCBS NC plans
-- with Tier 5 services that Sonnet flagged as `proposed_tier5_*` (variant slug
-- names). Without a canonical Tier 5 slug, the import script silently dropped
-- these services.
--
-- This migration adds:
--   1. A new concept in concepts table (vocabulary_id='CANDID', code='specialty_rx_tier5')
--   2. A new service_catalog row with canonical_for_concept=TRUE
--
-- Idempotent via ON CONFLICT DO NOTHING. Safe to re-apply.
--
-- Architectural note (per [[Candid_Data_Patterns]] Pattern 1 #2 +
-- candid/CLAUDE.md Rule #2): service names live in concepts + service_catalog,
-- never hardcoded. Adding a row is the correct way to extend the vocabulary.
--
-- Follow-on work (filed as CF after S104):
--   - Update src/lib/plan_doc/haiku-prompts/services-cost-sharing.ts to include
--     specialty_rx_tier5 in STANDARD_SLUGS so production Haiku also extracts it
--     (currently constrained to 68 slugs from S95 B1; would become 69).
--   - Re-import the 3 BCBS NC plans whose Tier 5 services were dropped at
--     S104 batch import (script in vault tools/admin-cold-start-sonnet/).

-- ── Part 1: insert the concept (CANDID vocabulary) ──
INSERT INTO concepts (vocabulary_id, concept_code, concept_name, concept_class, domain, is_active)
VALUES (
  'CANDID',
  'specialty_rx_tier5',
  'Specialty Drugs (Tier 5)',
  'service',
  'service',
  TRUE
)
ON CONFLICT (vocabulary_id, concept_code) DO NOTHING;

-- ── Part 2: insert the service_catalog row, linked to the concept above ──
INSERT INTO service_catalog (slug, name, category, concept_id, canonical_for_concept, proposal_state)
SELECT
  'specialty_rx_tier5',
  'Specialty Drugs (Tier 5)',
  'rx',
  c.id,
  TRUE,
  'canonical'
FROM concepts c
WHERE c.vocabulary_id = 'CANDID' AND c.concept_code = 'specialty_rx_tier5'
ON CONFLICT (slug) DO NOTHING;

COMMENT ON COLUMN service_catalog.slug IS
  'Canonical short identifier per Pattern 1 #2. 69 canonical slugs as of S104 (specialty_rx_tier5 added for BCBS NC + similar carriers).';
