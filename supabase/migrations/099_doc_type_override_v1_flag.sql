-- S91 — doc_type_override_v1 feature flag + admin-tunable knobs.
--
-- Stores configuration for the upload route's effective-doc-type resolver
-- (src/lib/documents/effective-doc-type.ts). Two tunable knobs:
--   - classifier_confidence_override (default 0.8): minimum classifier
--     confidence at which we override the user's pick.
--   - sbc_max_pages (default 20): if user picks "SBC" but pageCount > this,
--     force routing to plan_document parser. SBCs cap at 8 pages by federal
--     rule; ~15 typical with state addenda; 20 is the safe ceiling.
--
-- When `enabled=false`, the resolver bypasses all overrides and trusts the
-- user's pick. Use this as a kill switch if the override is causing problems
-- in production.
--
-- Admin tunes both knobs via /admin/upload-settings (S91). Mirrors mig 075's
-- INSERT shape (target_type + config JSONB; flag_key UNIQUE).
--
-- Default enabled=true so the resolver is active immediately on apply. Defaults
-- match resolveEffectiveDocType's DEFAULT_DOC_TYPE_OVERRIDE_CONFIG constant.

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'doc_type_override_v1',
  true,
  'S91 (Session 91). Effective doc-type resolver — overrides the user''s upload-form doc-type pick when (a) the Haiku-based quick-classifier disagrees with confidence >= classifier_confidence_override (Rule 1), or (b) the user picked SBC but pageCount > sbc_max_pages (Rule 2 safety net). Catches user mis-picks like uploading a 150-page Cigna EOC as "SBC" (the original S91 trigger). Asymmetric safety net — no reverse rule for short Plan Docs because SOBs / SPDs legitimately span a wide page range. When enabled=false, all overrides are bypassed and user pick is trusted. Knobs admin-tunable via /admin/upload-settings.',
  'global',
  '{"classifier_confidence_override":0.8,"sbc_max_pages":20}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
