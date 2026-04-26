-- Migration 053: dispute_letter_v2 feature flag
--
-- Gates the Phase 2+ redesigned dispute letter UI (hero strip, recipient
-- card, evidence block, missing-plan banner, download warning modal). OFF by
-- default globally. Flip ON for test users via /admin/flags first, then
-- globally once verified.

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type)
VALUES (
  'dispute_letter_v2',
  false,
  'Enable redesigned dispute letter page (hero strip, insurer-aware recipient card, Why-covered evidence block, missing-plan banner, download warning).',
  'global'
)
ON CONFLICT (flag_key) DO NOTHING;
