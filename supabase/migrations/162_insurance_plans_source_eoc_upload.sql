-- Migration 162: allow 'eoc_upload' as an insurance_plans.source value (S195)
--
-- ROOT CAUSE (S195, found via the EOC-RESUME loud-failure fix): the
-- insurance_plans.source CHECK constraint (mig 009) has always been
--   CHECK (source IN ('sbc_upload','plan_doc_upload','catalog_match','manual','insurance_card'))
-- and 'eoc_upload' was NEVER added — even though mig 059's header comment
-- documented "'eoc_upload' value used in insurance_plans.source TEXT column".
-- mig 059's body only did `ALTER TYPE doc_type ADD VALUE 'eoc'` + a flag
-- INSERT; the constraint ALTER it described was never written. Implementation
-- drift, latent because the EOC parser never ran in PROD until #189 made it
-- reachable. processEOCDocumentData writes `source: "eoc_upload"` on BOTH the
-- merge-UPDATE and new-row-INSERT identity-persist paths, so every EOC
-- identity persist was rejected by Postgres ("violates check constraint
-- insurance_plans_source_check"). The S195 loud-failure fix surfaced it from
-- the silent-park state; this migration closes it.
--
-- ALREADY APPLIED TO PROD via Supabase Studio (Andrew, 2026-06-12) — this file
-- is the committed record so a fresh-DB rebuild reproduces it. Re-running is a
-- no-op (DROP IF EXISTS + idempotent re-add).
--
-- ADDITIVE (Rule 7): widens an enum allow-list — no existing row can violate
-- the superset. Mirrors the mig 018 DROP+ADD pattern for verification_status.
-- Rollback: re-add the constraint without 'eoc_upload' (safe pre-launch — no
-- eoc_upload rows exist until this is applied).

BEGIN;

ALTER TABLE insurance_plans DROP CONSTRAINT IF EXISTS insurance_plans_source_check;

ALTER TABLE insurance_plans ADD CONSTRAINT insurance_plans_source_check
  CHECK (source IN (
    'sbc_upload',
    'plan_doc_upload',
    'eoc_upload',
    'catalog_match',
    'manual',
    'insurance_card'
  ));

COMMIT;
