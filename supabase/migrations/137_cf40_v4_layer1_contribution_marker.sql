-- =============================================================================
-- MIGRATION 137 — CF-40 v4 Layer 1 contribution marker (Ing-D.0b)
-- =============================================================================
--
-- WHY (Subplan [[plans/s73.5_cf40_refine]] §2.2 + [[pre_launch_backend_hardening]]
-- Ing-D.0b):
--   CF-40 v4 Layer 1 validity gates decide whether a parse event is allowed to
--   CONTRIBUTE to Layer 2 stability (`canonical_document_stability.
--   parse_weight_accumulated`) AND Layer 3 coverage/corroboration. Per §2.2:
--   "A parse contributes to stability counter AND coverage scoring ONLY IF all
--   gates pass. Failure → parse runs normally + data persists to user-scoped row
--   + NO contribution to stability/coverage."
--
--   Ing-D.0a (mig 086 / PR #153) wired Layer 2 weight + Layer 3 promotion but did
--   NOT gate them on Layer 1 — so today stability/promotion can accrue from
--   parses that would fail Layer 1 (low self-check, garbled OCR, off-window doc,
--   banned uploader). Ing-D.0b closes that: `recordParseEventV4` now evaluates
--   Layer 1 and records the pass/fail verdict per parse so the Layer 3 aggregator
--   (`gatherLayer3Inputs`) can EXCLUDE failed parses from coverage/corroboration.
--
-- WHAT THIS MIGRATION ADDS:
--   1. ALTER documents — cf40_layer1_passed BOOLEAN (nullable). Written by the
--      FLAG-ON path of recordParseEventV4 (TRUE when all Layer 1 gates pass for
--      the parse, FALSE otherwise). NULL = parse predates this gate OR was
--      recorded while cf40_v4_algorithm was OFF → conservatively EXCLUDED from
--      Layer 3 coverage/corroboration (we never Layer-1-evaluated it).
--
-- BACKOUT:
--   Application-layer rollback: keep cf40_v4_algorithm flag OFF — the column is
--   only written on the FLAG-ON path and only read by the FLAG-ON aggregator.
--   Schema is additive only (one nullable column); revert PR leaves the column
--   harmless + unread.
--
-- FORWARD-ONLY:
--   No backfill. Pre-existing documents stay NULL by design — they were never
--   Layer-1-evaluated, so they must not count toward promotion. When the flag
--   flips ON (Ing-D.1), fresh parses begin marking TRUE/FALSE and promotion
--   builds from gated corroboration only (the intended reliability property).
--
-- PILLAR: P2 (cross-service data flow — flywheel corroboration integrity).
-- =============================================================================

BEGIN;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS cf40_layer1_passed BOOLEAN;

COMMENT ON COLUMN documents.cf40_layer1_passed IS
  'CF-40 v4 Layer 1 (Ing-D.0b). Per-parse validity-gate verdict written by recordParseEventV4 on the cf40_v4_algorithm FLAG-ON path: TRUE = all applicable Layer 1 gates passed (self-check ≥0.95 when present, OCR ≥0.85 when present, classification ≥0.90 when present, plan-year validity window, file size ≥ doc-type min, uploader authed + not banned, canonical not re_baseline_required); FALSE = at least one gate failed. NULL = parse predates the gate OR was recorded while the flag was OFF. gatherLayer3Inputs counts ONLY cf40_layer1_passed = TRUE rows toward coverage/corroboration (NULL + FALSE excluded — conservative; §2.2 "contributes ONLY IF all gates pass").';

COMMIT;
