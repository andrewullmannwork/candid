-- Migration 159: thesaurus Phase 1a — code-cache provenance relabel
--
-- Companion to the Step A code change that makes billing_code_mappings code-row
-- provenance EXPLICIT. Two effects, BOTH byte-identical to readers (the coded
-- cache is trusted by observation/confidence, NOT by `source` — see
-- src/lib/claims/service-resolver.ts readCodeCacheBatch / Decision 2):
--
--   1. Normalize off-formula confidence on resolver-written coded rows back to
--      code-intelligence's observation formula (0.50 + 0.05 * observation_count,
--      capped 0.95), so confidence honestly reflects accumulated evidence for
--      every coded row.
--   2. Relabel coded rows' source: NULL (legacy code-intelligence writes, which
--      omitted source) and 'haiku_resolver' (single-Haiku resolver writes, now
--      suppressed under the flag) → 'code_observation'. After this, ZERO coded
--      rows carry the 'haiku_resolver' label; only code-LESS signature rows can
--      (those are the trust-tiered synonym quarantine targets, handled in code).
--
-- Idempotent (re-run is a no-op). ADDITIVE / data-only — no schema change. Apply
-- anytime (inert; source is not read for coded-cache trust).
--
-- CAVEAT (honest): while `thesaurus_phase1a_v1` is OFF, the resolver writeback
-- still fires, so a coded line resolved via Haiku CAN re-introduce a cosmetic
-- coded `source='haiku_resolver'` row (and re-inflate its confidence to Haiku's
-- value) after this migration. That is harmless — coded `source` is not read for
-- trust, and conf 0.80 vs 0.95 both clear the 0.80 serve gate. When the flag
-- flips ON (Phase 2 exposure), the writeback is suppressed and no new
-- 'haiku_resolver' rows are written at all.
--
-- ROLLBACK: source origin (NULL vs haiku_resolver) is not preserved — both were
-- code-anchored cache rows, so the distinction is immaterial. To revert the
-- relabel: UPDATE billing_code_mappings SET source = NULL
--   WHERE billing_code IS NOT NULL AND source = 'code_observation';
-- (the confidence normalization is not reverted — the formula value is correct).

BEGIN;

-- 1. Normalize confidence on resolver-written coded rows to the observation formula.
UPDATE billing_code_mappings
SET confidence = LEAST(0.95, 0.50 + 0.05 * observation_count)
WHERE billing_code IS NOT NULL
  AND source = 'haiku_resolver'
  AND confidence <> LEAST(0.95, 0.50 + 0.05 * observation_count);

-- 2. Relabel coded rows to explicit code-observation provenance.
UPDATE billing_code_mappings
SET source = 'code_observation'
WHERE billing_code IS NOT NULL
  AND (source IS NULL OR source = 'haiku_resolver');

COMMIT;
