-- Migration 062: sbc_parser_v1 feature flag seed.
-- Per plans/phase_3.2_sbc_parser_refactor.md §Migration list.
-- Gates Phase 3.2 SBC parser refactor (Haiku-first replacement of legacy regex parser):
--   - New src/lib/sbc/ Haiku-first parser with Pattern P-8 source_excerpt + DR-3D
--   - DR-3C N=3 voting on cold-start (per Pattern P-3 hard rule)
--   - 7 universal mechanisms inherited from Phase 3.1A.1 EOC parser via shared library
-- OFF by default globally. Flip ON for admin user accounts via /admin/flags first;
-- after 7-day soak, flip ON globally; after 30-day soak, drop legacy sbc-parser.ts
-- code paths in a follow-up PR (per Subplan §Rollout sequencing).

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type)
VALUES (
  'sbc_parser_v1',
  false,
  'Phase 3.2 SBC parser refactor — Haiku-first replacement of legacy regex parser. Pattern P-8 source_excerpt provenance + DR-3D Haiku integration patterns + DR-3C N=3 cold-start voting + 7 universal mechanisms from Phase 3.1A.1. OFF = legacy regex sbc-parser.ts (no P-8, no voting).',
  'global'
)
ON CONFLICT (flag_key) DO NOTHING;
