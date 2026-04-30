-- Migration 057: parse_strategy_v2 feature flag seed.
-- Per plans/phase_3_parse_strategy_refactor.md §Feature flag list.
-- Gates Phase 3 parser refactor changes:
--   - Per-field confidence write to claim_line_items.field_provenance (DR-3B)
--   - Future SBC parser refactor (Phase 3.2; not wired yet)
--   - Future card scanner refactor (Phase 3.3; not wired yet)
--   - Future DR-3C 3-parse voting (Phase 3.2; not wired yet)
-- OFF by default globally. Flip ON for admin user accounts via /admin/flags first;
-- after 7-day soak, flip ON globally; after 30-day soak, drop legacy parser code paths
-- in a follow-up PR (per Subplan §Feature flag list rollout sequence).

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type)
VALUES (
  'parse_strategy_v2',
  false,
  'Phase 3 parser refactor — per-field confidence writes (DR-3B), DR-3X outlier flag emission, future 3-parse voting (DR-3C, Phase 3.2). OFF = legacy parsers + skip field_provenance writes.',
  'global'
)
ON CONFLICT (flag_key) DO NOTHING;
