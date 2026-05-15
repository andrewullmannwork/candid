-- Migration 105: add 'long_term_care' to service_catalog.category CHECK constraint.
-- Pillar: P1 (Document Ingestion) + P4 (Infra)
-- S94 Work Block B1 — service_catalog category cleanup.
--
-- S94 LOCK §"Locked Canonical Winners" specifies a `long_term_care` category for
-- 5 slugs (hospice_inpatient, hospice_outpatient, long_term_care,
-- private_duty_nursing, skilled_nursing). The original service_catalog.category
-- CHECK constraint (mig 009 line 14-17) doesn't permit this value, so the S94
-- reset-and-reseed script bucketed those 5 rows under category='other'.
--
-- That triggered the admin panel's "Needs Categorization" filter for 5 rows that
-- have a perfectly clear canonical category, just not one the constraint allowed.
-- This migration adds the value + reassigns the affected rows.
--
-- Additive only (per CLAUDE.md Rule #7): existing category values preserved.
--
-- ROLLBACK:
--   BEGIN;
--   UPDATE service_catalog SET category = 'other' WHERE category = 'long_term_care';
--   ALTER TABLE service_catalog DROP CONSTRAINT service_catalog_category_check;
--   ALTER TABLE service_catalog ADD CONSTRAINT service_catalog_category_check
--     CHECK (category IN ('office_visit','emergency','hospital','imaging','lab','rx',
--                         'therapy','mental_health','maternity','dme','preventive','other'));
--   COMMIT;

BEGIN;

-- === DROP + RECREATE CHECK CONSTRAINT WITH NEW VALUE ===

ALTER TABLE service_catalog DROP CONSTRAINT IF EXISTS service_catalog_category_check;

ALTER TABLE service_catalog
  ADD CONSTRAINT service_catalog_category_check
  CHECK (category IN (
    'office_visit','emergency','hospital','imaging','lab','rx',
    'therapy','mental_health','maternity','dme','preventive',
    'long_term_care','other'
  ));

-- === REASSIGN THE 5 LTC SLUGS ===

UPDATE service_catalog
SET category = 'long_term_care'
WHERE slug IN (
  'hospice_inpatient',
  'hospice_outpatient',
  'long_term_care',
  'private_duty_nursing',
  'skilled_nursing'
)
  AND category = 'other';

COMMIT;
