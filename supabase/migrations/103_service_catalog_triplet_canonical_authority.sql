-- Migration 103: service_catalog triplet-based canonical authority
-- Pillar: P1 (Document Ingestion) + P4 (Infra)
-- S94 Work Block B1 — implements [[plans/s94_unified_parser_meet_or_beat]] Stage 1
--
-- DRAFT — LOCKED AT S94 CLOSE 2026-05-15 PM
-- LANDING PATH: copy to /Users/andrewullmann/Desktop/candid/supabase/migrations/103_service_catalog_triplet_canonical_authority.sql
-- at B1 kickoff. Branch off main + apply to dev first + smoke test trigger function + then PROD-apply via
-- Supabase Studio per OPS.9 protocol (user-applies-to-prod).
--
-- Adds 3 columns to service_catalog enabling alias resolution via concept_id grouping:
--   canonical_for_concept BOOLEAN — flag identifying canonical winner per concept_id cluster
--   proposal_state TEXT — state machine for slug lifecycle
--   deprecated_at TIMESTAMPTZ — soft-deprecation timestamp per Pattern 1 #10 no-hard-delete
--
-- Plus trigger function enforcing exactly-one-canonical-per-concept invariant.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_enforce_canonical_per_concept ON service_catalog;
--   DROP FUNCTION IF EXISTS enforce_canonical_per_concept();
--   DROP INDEX IF EXISTS idx_service_catalog_concept_canonical;
--   DROP INDEX IF EXISTS idx_service_catalog_proposal_state;
--   ALTER TABLE service_catalog DROP COLUMN canonical_for_concept;
--   ALTER TABLE service_catalog DROP COLUMN proposal_state;
--   ALTER TABLE service_catalog DROP COLUMN deprecated_at;

BEGIN;

-- === COLUMN ADDITIONS ===

ALTER TABLE service_catalog
  ADD COLUMN canonical_for_concept BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN proposal_state TEXT NOT NULL DEFAULT 'canonical'
    CHECK (proposal_state IN ('canonical', 'alias', 'proposed', 'deprecated', 'junk')),
  ADD COLUMN deprecated_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN service_catalog.canonical_for_concept IS
  'TRUE = this row is the preferred canonical slug for its concept_id. FALSE = this row is an alias of a canonical sibling sharing concept_id. Enforced via enforce_canonical_per_concept() trigger.';

COMMENT ON COLUMN service_catalog.proposal_state IS
  'State machine for slug lifecycle: canonical (active+preferred, default) | alias (active+secondary) | proposed (awaiting admin review via Pattern P-9) | deprecated (sunset; preserved per Pattern 1 #10) | junk (Haiku noise / boilerplate fragment; preserved per Pattern 1 #10).';

COMMENT ON COLUMN service_catalog.deprecated_at IS
  'Timestamp when this row was marked deprecated or junk. NULL when proposal_state in (canonical, alias, proposed). Preserved per Pattern 1 #10 no-hard-delete policy.';

-- === TRIGGER FUNCTION: enforce exactly-one-canonical-per-concept ===

CREATE OR REPLACE FUNCTION enforce_canonical_per_concept()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Only validate when concept_id is set AND the row is marked as alias
  IF NEW.concept_id IS NOT NULL AND NEW.canonical_for_concept = FALSE THEN
    IF NOT EXISTS (
      SELECT 1 FROM service_catalog
      WHERE concept_id = NEW.concept_id
        AND canonical_for_concept = TRUE
        AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::UUID)
    ) THEN
      RAISE EXCEPTION 'service_catalog: cannot mark row as alias (canonical_for_concept=FALSE) when no sibling canonical row exists for concept_id %', NEW.concept_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_canonical_per_concept ON service_catalog;
CREATE TRIGGER trg_enforce_canonical_per_concept
  BEFORE INSERT OR UPDATE ON service_catalog
  FOR EACH ROW EXECUTE FUNCTION enforce_canonical_per_concept();

COMMENT ON FUNCTION enforce_canonical_per_concept() IS
  'S94 Work Block B1 (mig 103). Enforces that every concept_id cluster in service_catalog has exactly one canonical winner. Aliases (canonical_for_concept=FALSE) must have a sibling canonical row sharing concept_id. Prevents orphan aliases from breaking resolveCanonicalSlug() resolution.';

-- === INDEXES FOR CANONICAL RESOLUTION ===

CREATE INDEX IF NOT EXISTS idx_service_catalog_concept_canonical
  ON service_catalog (concept_id, canonical_for_concept)
  WHERE concept_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_service_catalog_proposal_state
  ON service_catalog (proposal_state)
  WHERE proposal_state != 'canonical';

COMMIT;
