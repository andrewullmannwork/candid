-- Migration 180: Service Thesaurus A2b — roll back mig-179 Part 2 (inpatient phys/surgeon supersession)
--
-- WHY: the A2b N=9-gate CANARY (legC, N=1, 2026-06-24) caught a DETERMINISTIC correct→incorrect regression
-- introduced by mig-179 Part 2. That supersession re-pointed the signature 'fees inpt physician surgeon'
-- from hospital_admission → surgery (S222 "Model A"). mig-179's stated premise — "No current GT row hits
-- this signature" — was FALSE: the corpus carries the federal-SBC-template row "Physician/surgeon fees
-- (inpatient)" across 13+ plans (PacificSource, Blue Cross NC, WellSense, Ambetter, Community Health
-- Choice, …). That string NORMALIZES to 'fees inpt physician surgeon', so the seed fires as a DETERMINISTIC
-- Tier-1b cache hit (no Haiku) and forces every such row to surgery — but the oracle GT has them as
-- hospital_admission. Result: ~13+ deterministic regressions (B2 96.4% → 90.5% at N=1; would persist at N=9).
--
-- WHY NOT just re-adjudicate the GT to surgery: the federal-template line "Physician/surgeon fees" is
-- COMPOUND — surgeon's fee (→ surgery) for a SURGICAL admission, attending/hospitalist fee (→ NOT surgery)
-- for a MEDICAL admission. No single slug is correct. This is genuinely Phase-2 (component / multi-label)
-- territory: the resolver must emit surgery·component=professional vs hospital_admission·component=professional,
-- scored by the upgraded tuple harness. Forcing a uniform slug (either surgery OR hospital_admission) is
-- wrong for one case. Phase 1 is slug-only, so the correct Phase-1 move is to NOT pretend it is solved:
-- restore the GT-consistent interim default (hospital_admission, = mig-154's original) and resolve the
-- surgeon-vs-room/attending split properly in Phase 2 (the lead item), together with the EOC↔SBC GT
-- reconciliation ("…services in an inpatient facility" → surgery vs "…fees (inpatient)" → hospital_admission).
-- No exposure risk: thesaurus_phase1a_v1 is OFF, and Phase 2 lands before BOTH the cold-start regen
-- (Group B) and the global Flip B flip.
--
-- SCOPE: reverses ONLY mig-179 Part 2. mig-179 Part 1 (the 3 federal-SBC-template recall seeds —
-- facility-fee-room→hospital_admission, ASC-fee→surgery, outpatient phys/surgeon→surgery) STAYS: all 3
-- MATCH the oracle GT (verified by the legB/legC scorecards — zero regression from Part 1).
--
-- Data-only, additive, idempotent (a no-op if already hospital_admission), reversible. PRE-LAUNCH, no users,
-- flag OFF. Andrew Studio-applies the WHOLE file. VALIDATION = the N=9 gate AFTER apply (not asserted here).
-- Next-free mig after this = 181.

BEGIN;

-- Restore the mig-154 mapping that mig-179 Part 2 superseded (Model A inpatient supersession deferred to Phase 2).
UPDATE billing_code_mappings
  SET service_slug = 'hospital_admission'
  WHERE description_signature = 'fees inpt physician surgeon'
    AND source = 'thesaurus_remap'
    AND billing_code IS NULL;

COMMIT;

-- ── VERIFY (run with the file). Expect 8 thesaurus_remap code-less rows total, with
--    'fees inpt physician surgeon' = hospital_admission again (Part 1's 3 seeds unchanged). ──
SELECT description_signature, service_slug
FROM billing_code_mappings
WHERE source = 'thesaurus_remap' AND billing_code IS NULL
ORDER BY service_slug, description_signature;

-- ── ROLLBACK of THIS mig (re-apply mig-179 Part 2 → surgery) — only if Phase 2 decides slug-only surgery: ──
-- UPDATE billing_code_mappings SET service_slug='surgery'
--   WHERE description_signature='fees inpt physician surgeon' AND source='thesaurus_remap' AND billing_code IS NULL;
