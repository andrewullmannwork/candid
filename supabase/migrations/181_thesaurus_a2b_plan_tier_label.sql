-- Migration 181: Service Thesaurus A2b Phase 2 (item 5) — plan_tier_label modifier.
-- ADDITIVE ONLY (Rule #7). Pattern S / Hard Rule #17: the drug FORMULARY tier ("Tier N") is a
-- plan-LOCAL modifier, NOT part of the service slug. The slug stays the drug DESCRIPTOR (generic_rx /
-- preferred_brand_rx / non_preferred_brand_rx / specialty_rx / non_preferred_specialty_rx); the tier
-- rides alongside, parallel to place_of_service + component (mig 147).
--
-- SCOPE (A2b Phase 2): ADDS THE COLUMN ONLY. Deliberately does NOT re-key uq_canonical_plan_service.
-- Re-keying to include plan_tier_label would require every canonical_plan_services upsert
-- (canonical-match.ts, wire-plan-catalog-to-canonical.ts, …) to target the new key in the SAME change,
-- or those writes throw "no unique constraint matching the ON CONFLICT specification" — and those
-- upserts run independently of the (OFF) thesaurus_phase1a_v1 flag. The write-path that POPULATES this
-- column is the cold-start regeneration (Group B); the re-key + ON CONFLICT update land THERE, in
-- lockstep. Phase 2 only emits + scores the modifier in the calibration harness — nothing writes this
-- column yet. (See [[a2b_precision_remediation]] §8 + [[coldstart_regeneration]] §15.)
--
-- VALUE VOCABULARY: 'none' (default — not a drug-tier row; the analogue of place='any' /
-- component='global') or 'tier_<n>' for n = 1..12 (covers every real US formulary with headroom). Tier
-- NUMBERING is plan-local and NOT cross-plan comparable (Hard Rule #17) → plan-local metadata, never a
-- comparison key. The raw SBC wording is preserved verbatim in source_excerpt (§14 cite-grade), so
-- normalizing to 'tier_n' here loses nothing.
--
-- PRE-LAUNCH: no PROD users. Existing canonical_plan_services rows all take plan_tier_label='none'; the
-- 4-col unique key is unchanged, so this apply is a pure (metadata-only, no table rewrite) column add —
-- ZERO collisions, ZERO behavioral change.

ALTER TABLE canonical_plan_services
  ADD COLUMN IF NOT EXISTS plan_tier_label TEXT NOT NULL DEFAULT 'none'
    CHECK (plan_tier_label = 'none' OR plan_tier_label ~ '^tier_([1-9]|1[0-2])$');

COMMENT ON COLUMN canonical_plan_services.plan_tier_label IS
  'A2b Phase 2 (mig 181): drug FORMULARY tier as a plan-local modifier (Hard Rule #17) — ''none'' or ''tier_1''..''tier_12''. Slug carries the drug descriptor; this carries the tier. Populated by cold-start regen (Group B), which also re-keys uq_canonical_plan_service to include this column + updates every upsert ON CONFLICT target in lockstep. NOT yet part of the unique key.';

-- ── ROLLBACK ──
-- ALTER TABLE canonical_plan_services DROP COLUMN IF EXISTS plan_tier_label;
