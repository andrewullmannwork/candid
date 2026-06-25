-- Migration 179: Service Thesaurus A2b — re-map signature seeds (Phase 1, S222)
-- Data-only (no schema change). Mirrors mig 154 (thesaurus_remap signature seeds).
--
-- WHY: the A2b GT re-adjudication + dry-run exposed FEDERAL-SBC-TEMPLATE benefit-row labels the resolver
-- flips on. Encoding them as CODE-LESS signature-cache rows makes the resolver serve them DETERMINISTICALLY
-- at Tier-1b (no Haiku, no flip), gated by thesaurus_phase1a_v1 (OFF → not served → byte-identical;
-- exposure-held to Flip B).
--
-- SCOPE = ONLY federal-SBC-template labels (cross-carrier-standard vocabulary; a seed here fires on ANY
-- carrier's doc → independently justified, NOT circular). Carrier-specific EOC phrasings (autism, water,
-- travel, ostomy, ECT, TMS, ortho, low-vision, early-intervention, weight-loss, rehab-variant, the BSC
-- phys-services variants, diagnostic-xray, telehealth) were DELIBERATELY NOT SEEDED — seeding a one-carrier
-- GT string = circular self-grading (feedback_calibration_independence) + an insurer-specific patch
-- (feedback_universal_fixes_only). Those themes ride the mig-178 enriched catalog + Haiku; the N=9 gate
-- MEASURES them; any residual miss gets a UNIVERSAL concept-level prompt rule in Phase 2, not a seed here.
--
-- description_signature is the NORMALIZED form COMPUTED by scripts/calibration/thesaurus/seed-remap.ts
-- (never hand-written). The rename-aware dry-run PROVED (vs the A2b GT): 0 collisions, 0 no-concept
-- over-map → B1 97.80% → 98.68% (+20 hits, floor ≥97.0). B2 from seeds = +0 by design (these are pure
-- recall anchors; precision improvement comes from Haiku + the GT corrections, proven by the gate).
--
-- confidence 0.95 (≥cacheMinConfidence served; ≥reviewConfidenceFloor not-needsReview; <1.0 still
-- correctable). source='thesaurus_remap' = auditable + reversible. Idempotent ON CONFLICT DO NOTHING
-- (mig-135 partial-unique on (description_signature, service_slug) WHERE billing_code IS NULL).
--
-- ⚠ Part 2 = ONE supersession: the mig-154 'fees inpt physician surgeon' → hospital_admission row is
-- re-pointed to 'surgery' (S222 Model A: a surgeon's professional fee is surgical work → surgery;
-- hospital_admission is the institutional/room charge). Keeps the plan side consistent with the claim side
-- (surgical CPT → surgery) so bill↔coverage matching holds. (No current GT row hits this signature — it is
-- a forward-consistency fix for future "Physician/surgeon fees (inpatient)" docs.)
--
-- PRE-LAUNCH, no users. Ship LIVE to PROD (D5). Andrew Studio-applies the WHOLE file. VALIDATION = the
-- N=9 gate AFTER apply (not asserted here). Next-free mig after this = 180.

BEGIN;

-- ── PART 1 — federal-SBC-template recall seeds (signatures from seed-remap.ts --emit-sql) ──
INSERT INTO billing_code_mappings (billing_code, billing_code_type, description_signature, service_slug, confidence, observation_count, provider_descriptions, source)
  VALUES (NULL, NULL, 'facility fee hospital room', 'hospital_admission', 0.95, 1, '{}', 'thesaurus_remap') ON CONFLICT DO NOTHING;  -- Facility fee (e.g., hospital room)
INSERT INTO billing_code_mappings (billing_code, billing_code_type, description_signature, service_slug, confidence, observation_count, provider_descriptions, source)
  VALUES (NULL, NULL, 'ambulatory center facility fee surgery', 'surgery', 0.95, 1, '{}', 'thesaurus_remap') ON CONFLICT DO NOTHING;  -- Facility fee (e.g., ambulatory surgery center)
INSERT INTO billing_code_mappings (billing_code, billing_code_type, description_signature, service_slug, confidence, observation_count, provider_descriptions, source)
  VALUES (NULL, NULL, 'fees outpt physician surgeon', 'surgery', 0.95, 1, '{}', 'thesaurus_remap') ON CONFLICT DO NOTHING;  -- Physician/surgeon fees (outpatient)

-- ── PART 2 — supersede the mig-154 inpatient phys/surgeon seed (Model A: → surgery) ──
UPDATE billing_code_mappings
  SET service_slug = 'surgery'
  WHERE description_signature = 'fees inpt physician surgeon'
    AND source = 'thesaurus_remap'
    AND billing_code IS NULL;

COMMIT;

-- ── VERIFY (run with the file). Expect 8 thesaurus_remap code-less rows total (mig-154's 5 + these 3),
--    with 'fees inpt physician surgeon' now = surgery (was hospital_admission). ──
SELECT description_signature, service_slug
FROM billing_code_mappings
WHERE source = 'thesaurus_remap' AND billing_code IS NULL
ORDER BY service_slug, description_signature;

-- ── ROLLBACK (no users) ──
-- BEGIN;
--   UPDATE billing_code_mappings SET service_slug='hospital_admission'
--     WHERE description_signature='fees inpt physician surgeon' AND source='thesaurus_remap' AND billing_code IS NULL;  -- restore mig-154
--   DELETE FROM billing_code_mappings WHERE source='thesaurus_remap' AND billing_code IS NULL AND description_signature IN (
--     'facility fee hospital room','ambulatory center facility fee surgery','fees outpt physician surgeon');
-- COMMIT;
