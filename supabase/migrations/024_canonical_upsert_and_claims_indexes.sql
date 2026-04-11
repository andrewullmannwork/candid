-- Migration 024: Canonical plan unique constraints + claims indexes
-- Enables upsert deduplication for canonical plan matching and
-- efficient coverage discrepancy queries for claims tracking.

-- Unique constraints for canonical plan upsert deduplication
ALTER TABLE canonical_plan_services
  ADD CONSTRAINT uq_canonical_plan_service
  UNIQUE (canonical_plan_id, service_slug);

ALTER TABLE canonical_plans
  ADD CONSTRAINT uq_canonical_plan_identity
  UNIQUE (insurer_id, plan_name, state, plan_year);

-- Index for coverage discrepancy detection (claim denied + service marked covered)
CREATE INDEX IF NOT EXISTS idx_claim_line_items_service_slug
  ON claim_line_items(service_slug);

CREATE INDEX IF NOT EXISTS idx_claims_status
  ON claims(status);

-- Index for dispute outcome aggregation (success rates by insurer + service)
CREATE INDEX IF NOT EXISTS idx_dispute_outcomes_insurer_concept
  ON dispute_outcomes(insurer_id, concept_id);

CREATE INDEX IF NOT EXISTS idx_dispute_outcomes_status
  ON dispute_outcomes(status);
