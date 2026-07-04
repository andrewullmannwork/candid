-- =============================================================================
-- MIGRATION 198 — ocr_undecodable_page_fallback_v1 feature flag (EOB parse hotfix)
-- =============================================================================
--
-- Seeds the `ocr_undecodable_page_fallback_v1` row in `feature_flag_rules`.
-- Plan: plans/eob-ocr-per-page-fallback-hotfix.md.
--
-- WHAT IT GATES (src/lib/ocr/index.ts + pdf-text-extract.ts):
--   Per-page Document AI fallback. When pdfjs DRAWS text on a page but decodes
--   ~nothing (a real text layer with no ToUnicode CMap — e.g. some Kaiser /
--   Antenna-House EOB claim tables), ONLY that page is re-OCR'd via Document AI
--   and spliced back — pdfjs's byte-exact text is kept for every other page.
--   A page with no text-show ops (genuinely empty / image-only) is left to pdfjs
--   (proven: real SBC fixtures + image-only appendix pages flag 0 undecodable
--   pages → zero Document AI calls). Fixes the empty-parse root cause where the
--   sole claim page never reached the parser.
--
-- Detection is skipped entirely when this flag is OFF ⇒ OCR extraction is
-- byte-identical to pre-fix. Default ON (this is the fix); flip OFF to disable.
--
-- CONFIG (tunable thresholds; a page is undecodable iff it is a candidate AND
-- draws >= min_text_ops text-show ops AND decoded chars < textOps*min_chars_per_op):
--   candidate_max_chars — trimmed extracted length below which a page is probed (50)
--   min_text_ops        — text-show ops a candidate must draw to count as text-bearing (10)
--   min_chars_per_op     — undecodable when chars < textOps * this ratio (1.0)
--
-- ROLLOUT:
--   1. Merge + deploy the code (flag row absent ⇒ loader defaults enabled:false
--      ⇒ Fix B inert; Fix A gate is already active in the code).
--   2. Apply this migration (seeds enabled=true/global) ⇒ per-page fallback live.
--   3. Reprocess the stuck EOB uploads (or user re-uploads).
--
-- ROLLBACK:
--   UPDATE feature_flag_rules SET enabled=false WHERE flag_key='ocr_undecodable_page_fallback_v1';
--   (Row removal forbidden per Pattern 1 #10 hard-delete prohibition.)
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'ocr_undecodable_page_fallback_v1',
  true,
  'EOB parse hotfix. Per-page Document AI fallback in the OCR dispatcher: when pdfjs draws text on a page but decodes ~nothing (text layer with no ToUnicode CMap, e.g. some Kaiser/Antenna-House EOB claim tables), only that page is re-OCR''d via Document AI and spliced back, keeping pdfjs byte-exact text elsewhere. Pages with no text-show ops (empty/image-only) are left to pdfjs (clean SBCs flag 0 undecodable pages → no DocAI). OFF ⇒ detection skipped ⇒ extraction byte-identical to pre-fix. Config = detection thresholds. Default ON.',
  'global',
  '{"candidate_max_chars": 50, "min_text_ops": 10, "min_chars_per_op": 1.0}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
