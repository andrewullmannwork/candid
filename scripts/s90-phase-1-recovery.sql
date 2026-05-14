-- S90 Phase 1 overwrite recovery — run in Supabase Studio SQL Editor against PROD.
--
-- Context: Phase 1.2 Ambetter SBC upload (doc 76d22f2f, 2026-05-14 18:01 UTC)
-- silently merged into Andrew primary's existing Cigna OAP plan row
-- (38a33b4f). The Ambetter parser returned NULL plan-identity (insurer,
-- plan_name, plan_year) → merge logic in processPlanDocumentData defaulted
-- to matching the user's existing active plan instead of creating a new row,
-- and overwrote half the cost-share fields with Ambetter HDHP values:
--
--   field                  | cigna_oap_correct | corrupted | source
--   in_deductible_individual| $0               | $7,050    | Ambetter HDHP wrote
--   in_oop_max_individual   | $3,000           | $7,050    | Ambetter HDHP wrote
--   out_deductible_individual| $2,000          | $14,100   | Ambetter HDHP wrote
--   out_oop_max_individual  | $6,000           | $25,000   | Ambetter HDHP wrote
--   *_family fields         | (correct)        | (correct) | Cigna preserved
--
-- This script:
--   1. Restores the 4 corrupted individual cost-share fields to S71 baseline
--   2. Resets source_document_id back to the prior Cigna SBC (42a8061c)
--   3. Strips Ambetter-tainted field_provenance entries for those 4 fields
--      (Phase 4 consumer-read filter will mark them as "no cite-grade source"
--      until next clean Cigna upload re-establishes provenance — honest
--      degradation rather than fake-attestation)
--   4. Marks Ambetter doc (76d22f2f) + BSCA doc (52baa8c1, Phase 1.1)
--      as known-bad rejects so they don't pollute future smart-skip
--   5. Soft-deletes the orphan BSCA insurance_plans row (22c4c6c4) that
--      was created at Phase 1.1 with NULL plan_name + plan_year

BEGIN;

-- 1-3. Restore Andrew primary's Cigna OAP plan row
UPDATE insurance_plans SET
  in_deductible_individual = 0,
  in_oop_max_individual = 3000,
  out_deductible_individual = 2000,
  out_oop_max_individual = 6000,
  source_document_id = '42a8061c-25f9-4224-aedc-787ccfc5a6ce',
  field_provenance = (
    (field_provenance::jsonb)
      - 'in_deductible_individual'
      - 'in_oop_max_individual'
      - 'out_deductible_individual'
      - 'out_oop_max_individual'
  ),
  updated_at = NOW()
WHERE id = '38a33b4f-25dd-4b5e-bf2c-605074bd6ca8';

-- 4a. Mark Ambetter doc as rejected with overwrite-recovery reason
UPDATE documents SET
  status = 'error',
  processing_error = 'S90 Phase 1.2: plan-identity extraction returned NULL; auto-merged into user active plan (Cigna 38a33b4f) corrupting cost-share values. Manually unwound 2026-05-14 via SQL restore. Pending Bug X (parser plan-identity gap) + Bug Y (merge fallback) fix.',
  processing_step = 'rejected_overwrite_recovery'
WHERE id = '76d22f2f-4178-45bc-89d3-7e615a743ae1';

-- 4b. Same for BSCA doc from Phase 1.1
UPDATE documents SET
  status = 'error',
  processing_error = 'S90 Phase 1.1: plan-identity extraction returned NULL; created orphan insurance_plans row 22c4c6c4 with no plan_name or plan_year. Cost-share + ACA extracted correctly but flywheel-unusable without canonical anchor.',
  processing_step = 'rejected_overwrite_recovery'
WHERE id = '52baa8c1-1619-4a64-b0fe-bbf9840eb7fa';

-- 5. Soft-delete orphan BSCA insurance_plans row (already is_active=false; set historical_only=true for clarity)
UPDATE insurance_plans SET
  historical_only = true,
  updated_at = NOW()
WHERE id = '22c4c6c4-4b82-4c56-ba61-7e9a40a4da28';

-- Verify the restore landed correctly
SELECT
  id,
  insurer_name,
  plan_name,
  in_deductible_individual AS in_ded_ind,
  in_deductible_family AS in_ded_fam,
  in_oop_max_individual AS in_oop_ind,
  in_oop_max_family AS in_oop_fam,
  out_deductible_individual AS out_ded_ind,
  out_deductible_family AS out_ded_fam,
  out_oop_max_individual AS out_oop_ind,
  out_oop_max_family AS out_oop_fam,
  source_document_id,
  is_active,
  array_length(ARRAY(SELECT jsonb_object_keys(field_provenance)), 1) AS provenance_field_count
FROM insurance_plans
WHERE id = '38a33b4f-25dd-4b5e-bf2c-605074bd6ca8';

-- Expected verification output:
--   insurer_name='Cigna' / plan_name='Open Access Plus'
--   in_ded_ind=0, in_ded_fam=0
--   in_oop_ind=3000, in_oop_fam=6000
--   out_ded_ind=2000, out_ded_fam=4000
--   out_oop_ind=6000, out_oop_fam=12000
--   source_document_id='42a8061c-25f9-4224-aedc-787ccfc5a6ce'
--   provenance_field_count=4 (the 4 family fields)

-- If verification output matches, COMMIT.
-- If anything looks off, ROLLBACK and re-investigate.

COMMIT;
