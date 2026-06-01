-- =============================================================================
-- MIGRATION 135 — S153: Service-match unification
-- =============================================================================
--
-- Per plans/pre_launch_backend_hardening.md (new block "Service-match vocabulary
-- unification + learned synonyms") + S153 design.
--
-- PROBLEM (diagnosed S153, evidence-grounded):
--   Service matching is fragmented across 5 matchers over 3 vocabularies. The
--   USER-VISIBLE bill slug is set by `service-mapper.ts`, which matches against a
--   HARDCODED 72-slug list (mig 010 copy) that has drifted badly from the live
--   service_catalog (24 dead slugs / 21 live slugs missing) and feeds Haiku BARE
--   slugs (no names/descriptions). Result: "clearly similar but unknown" matches
--   and wellness→pcp_visit mis-categorization. Manual search is client substring.
--
-- FIX (this mig is the schema half):
--   Repurpose `billing_code_mappings` as the single IMMEDIATE learned cache for a
--   unified `resolveService()` resolver — (code,type)→slug AND signature→slug,
--   slug set immediately (NOT promotion-gated), confidence-scored. This is the
--   "Haiku match cached as a synonym, served first" store; it also doubles as the
--   manual-search synonym source. The cross-user corroboration machine
--   (billing_code_identity, threshold 5) is UNCHANGED — Pattern 1 #14 preserved
--   (canonical/identity slug stays vote-gated; user-scoped claim_line_items.slug
--   is written immediately as today).
--
-- WHAT THIS MIGRATION ADDS (all additive per CLAUDE.md Rule #7):
--   1. billing_code_mappings.description_signature TEXT — enables code-less
--      (signature → slug) cache rows for code-less bill lines + manual-search
--      learned synonyms. Coded rows may also carry it for richer keys.
--   2. billing_code_mappings.source TEXT — provenance per Rule #8
--      ('haiku_resolver' | 'user_correction' | 'corroborated' | 'admin' | 'legacy').
--   3. billing_code / billing_code_type → NULLABLE (code-less rows).
--   4. Partial UNIQUE (description_signature, service_slug) WHERE billing_code IS
--      NULL — prevents code-less duplicates (the existing UNIQUE(code,type,slug)
--      treats NULLs as distinct, so code-less rows need their own guard).
--   5. Trigram GIN index on description_signature — manual-search fuzzy lookup
--      against learned signatures (pg_trgm already enabled via migs 007/014/113).
--   6. service_resolver_v1 feature flag (default OFF; mig 075 INSERT shape per
--      feedback_candid_feature_flag_schema) with tunable resolver thresholds.
--      OFF = byte-identical current behavior (legacy service-mapper + D4 path).
--
-- ROLLBACK:
--   -- Code-less rows must be removed before re-adding NOT NULL:
--   DELETE FROM billing_code_mappings WHERE billing_code IS NULL;
--   DROP INDEX IF EXISTS uq_bcm_signature_slug_codeless;
--   DROP INDEX IF EXISTS idx_bcm_signature;
--   DROP INDEX IF EXISTS idx_bcm_signature_trgm;
--   ALTER TABLE billing_code_mappings ALTER COLUMN billing_code SET NOT NULL;
--   ALTER TABLE billing_code_mappings ALTER COLUMN billing_code_type SET NOT NULL;
--   ALTER TABLE billing_code_mappings DROP COLUMN IF EXISTS description_signature;
--   ALTER TABLE billing_code_mappings DROP COLUMN IF EXISTS source;
--   DELETE FROM feature_flag_rules WHERE flag_key = 'service_resolver_v1';
-- =============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1 — generalize billing_code_mappings into the unified learned cache
-- ============================================================================

ALTER TABLE billing_code_mappings
  ADD COLUMN IF NOT EXISTS description_signature TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT;

ALTER TABLE billing_code_mappings ALTER COLUMN billing_code DROP NOT NULL;
ALTER TABLE billing_code_mappings ALTER COLUMN billing_code_type DROP NOT NULL;

COMMENT ON COLUMN billing_code_mappings.description_signature IS
  'S153 (mig 135). Normalized description signature (normalizeDescriptionSignature)
   for code-less cache rows + richer code-ful keys. When billing_code IS NULL this
   is the cache key (signature → service_slug); it also powers manual-search
   learned-synonym lookup via the trigram index below.';

COMMENT ON COLUMN billing_code_mappings.source IS
  'S153 (mig 135). Provenance of this cache row per Rule #8:
   ''haiku_resolver'' (resolveService Haiku match), ''user_correction''
   (CategoryCorrectionModal), ''corroborated'' (promoted via flywheel),
   ''admin'', or ''legacy'' (pre-S153 rows; NULL).';

-- Code-less uniqueness guard. The existing UNIQUE(billing_code, billing_code_type,
-- service_slug) treats NULLs as DISTINCT (pre-PG15 default), so (NULL, NULL, slug)
-- could duplicate. This partial unique keys code-less rows by (signature, slug).
CREATE UNIQUE INDEX IF NOT EXISTS uq_bcm_signature_slug_codeless
  ON billing_code_mappings (description_signature, service_slug)
  WHERE billing_code IS NULL AND description_signature IS NOT NULL;

-- Exact signature lookup (code-less Tier-1 cache read).
CREATE INDEX IF NOT EXISTS idx_bcm_signature
  ON billing_code_mappings (description_signature)
  WHERE description_signature IS NOT NULL;

-- Fuzzy signature lookup for manual-search learned synonyms (pg_trgm enabled
-- via migs 007 + 014 + 113).
CREATE INDEX IF NOT EXISTS idx_bcm_signature_trgm
  ON billing_code_mappings USING GIN (description_signature gin_trgm_ops)
  WHERE description_signature IS NOT NULL;

-- ============================================================================
-- SECTION 2 — service_resolver_v1 feature flag (default OFF; mig 075 shape)
-- ============================================================================
-- OFF  = legacy path (service-mapper hardcoded list + D4 description-match) —
--        byte-identical to current behavior.
-- ON   = unified resolveService() path (live catalog + names/descriptions +
--        immediate learned cache + batched Haiku fallback).
--
-- Tunable thresholds (Ship Gate G6 — no code deploy to tune):
--   haiku_confidence_floor        min Haiku score to accept a match as the slug
--   writeback_confidence_floor    min confidence to write a learned cache row
--   review_confidence_floor       below this → needsReview=true (user prompted)
--   trigram_shortcircuit_threshold in-memory near-exact name match → skip Haiku
--   cache_min_confidence          min confidence for a cache row to be served
-- ============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'service_resolver_v1',
  false,
  'S153 (mig 135). Gates the unified service-match resolver (resolveService): live service_catalog vocabulary with names+descriptions, immediate learned cache in billing_code_mappings (code→slug + signature→slug; the "Haiku match cached as synonym, served first" store), tiered cost cascade (exact cache → code cache → trigram short-circuit → ONE batched Haiku call/bill), and synonym-aware manual search. When ON: bill categorization + /api/service-catalog/search + CategoryCorrectionModal route through the resolver. When OFF: legacy service-mapper hardcoded list + D4 description-match (byte-identical pre-S153 behavior). Cross-user corroboration (billing_code_identity, threshold 5) is unchanged. Tune thresholds via UPDATE feature_flag_rules SET config = jsonb_set(config, ''{haiku_confidence_floor}'', ''0.75'') WHERE flag_key=''service_resolver_v1''. Safe ranges: haiku_confidence_floor 0.6-0.8, writeback_confidence_floor 0.75-0.9, review_confidence_floor 0.5-0.7, trigram_shortcircuit_threshold 0.82-0.92, cache_min_confidence 0.7-0.9.',
  'global',
  '{"haiku_confidence_floor": 0.7, "writeback_confidence_floor": 0.8, "review_confidence_floor": 0.6, "trigram_shortcircuit_threshold": 0.86, "cache_min_confidence": 0.8}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
