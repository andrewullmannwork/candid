-- =============================================================================
-- MIGRATION 154 — Thesaurus Phase-1c re-map: standard SBC labels → representative slug (S171)
-- =============================================================================
--
-- WHY
--
-- The N=9 majority gate (after-mig152-s170) exposed a flippy CLASS of standard federal-SBC benefit-row
-- labels the resolver maps inconsistently because the target slugs are under-signalled in the catalog
-- (pt_rehab is named "Physical Therapy" with a NULL description; hospice_outpatient/hospital_admission
-- likewise). On these short, conventional labels Haiku hovers at the ~0.5 confidence boundary and flips
-- run-to-run — which de-noising correctly surfaced as a B1 recall miss (96.96%, one under the 97.0 floor)
-- and a B2 precision miss (hospice_inpatient mis-resolutions). The single-run baseline passed them by luck.
--
-- These labels are STANDARD SBC vocabulary (general; true on ANY SBC), NOT GT-specific. Encoding them as
-- code-less learned-cache synonyms makes the resolver serve them DETERMINISTICALLY at Tier-1b (no Haiku,
-- no flip — service-resolver.ts:472). SOURCE = the SBC template, NOT the GT oracle. The dry-run
-- (scripts/calibration/thesaurus/seed-remap.ts, rename-aware) PROVES each signature catches ONLY its
-- intended concept (0 collisions, 0 no-concept over-map) and quantifies the gain:
--   B1 96.96% → 97.98% (+23 hits, +22 over the ≥2204 floor) · B2 +7 andrew wrong→right.
-- The residual flippy entries the seed does NOT cover (2 ambiguous outpatient-hospital labels) stay
-- Haiku-resolved + quarantined — never promoted as truth, never written to canonical.
--
-- WHAT
--   Three code-less rows in billing_code_mappings (the unified learned cache, mig 135). description_
--   signature is the NORMALIZED form (normalizeDescriptionSignature) the resolver keys Tier-1b on —
--   COMPUTED by seed-remap.ts, never hand-written:
--     "Rehabilitation services"            → pt_rehab            (sig: rehabilitation services)        +18 B1
--     "Hospice services"                   → hospice_outpatient  (sig: hospice services)            +1 B1 / +5 B2
--     "Physician/surgeon fees (inpatient)" → hospital_admission  (sig: fees inpt physician surgeon)  +4 B1 / +2 B2
--       (oracle correctSlug inpatient_physician is MERGED into hospital_admission → the live target)
--
--   confidence 0.95 — ≥ cacheMinConfidence (0.8 → served) and ≥ reviewConfidenceFloor (0.6 → not
--   needsReview), but < 1.0 so even our own seeds stay CORRECTABLE by the contradiction/decay machinery
--   (don't weld them shut). source='thesaurus_remap' = distinct tag → auditable + surgically reversible.
--   observation_count 1; provider_descriptions '{}' (no user PII). Mirrors the resolver's own
--   cacheLearnedMapping INSERT shape (service-resolver.ts:372).
--
--   Idempotent: ON CONFLICT DO NOTHING against uq_bcm_signature_slug_codeless (mig 135 partial-unique on
--   (description_signature, service_slug) WHERE billing_code IS NULL) — re-apply is a safe no-op.
--
-- VALIDATION: the routing improvement (B1 ≥ 97.0 + B2 ≥ 86.7, 0 regressions, N-run MAJORITY) is proven by
-- the Step-6 resolver re-run AFTER this is applied — NOT asserted here.
--
-- ROLLBACK:
--   DELETE FROM billing_code_mappings WHERE source = 'thesaurus_remap';
--
-- Data-only INSERT (no schema change). Standard SBC vocabulary; admin-attested (Andrew, S171).

BEGIN;

INSERT INTO billing_code_mappings
  (billing_code, billing_code_type, description_signature, service_slug, confidence, observation_count, provider_descriptions, source)
  VALUES (NULL, NULL, 'rehabilitation services', 'pt_rehab', 0.95, 1, '{}', 'thesaurus_remap')
  ON CONFLICT DO NOTHING;

INSERT INTO billing_code_mappings
  (billing_code, billing_code_type, description_signature, service_slug, confidence, observation_count, provider_descriptions, source)
  VALUES (NULL, NULL, 'hospice services', 'hospice_outpatient', 0.95, 1, '{}', 'thesaurus_remap')
  ON CONFLICT DO NOTHING;

INSERT INTO billing_code_mappings
  (billing_code, billing_code_type, description_signature, service_slug, confidence, observation_count, provider_descriptions, source)
  VALUES (NULL, NULL, 'fees inpt physician surgeon', 'hospital_admission', 0.95, 1, '{}', 'thesaurus_remap')
  ON CONFLICT DO NOTHING;

COMMIT;
