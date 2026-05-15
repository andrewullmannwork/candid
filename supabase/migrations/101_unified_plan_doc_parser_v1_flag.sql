-- Migration 101: unified_plan_doc_parser_v1 feature flag seed (S93 Stage 3).
--
-- When ON for a user, all plan-doc-family classifications (sbc, eoc,
-- plan_document) route through the Haiku-first plan_doc parser
-- (src/lib/plan_doc/) instead of branching to dedicated SBC / EOC paths.
--
-- The plan_doc parser includes the Stage 3a layout-aware extraction shipped
-- in S92 (PR #76): pure-regex layout detector emits one of
--   federal_sbc_8page | federal_sbc_csr_variant | full_eoc_narrative
--   | employer_plan_booklet | plan_cert_summary | unknown
-- and conditionally injects the federal-SBC tabular supplement into the
-- plan-identity + services-cost-sharing prompts when layout matches federal
-- SBC patterns. EOCs detect as full_eoc_narrative so the supplement does NOT
-- inject — code path identical to today's plan_doc Haiku-first behavior.
--
-- Empirical S92 head-to-head on 7 SBC fixtures: plan_doc parser w/ supplement
-- = 88.8% aggregate vs SBC parser baseline 86.8% (+2.0pts). 6/7 fixtures
-- meet-or-beat. Catastrophic Ambetter Bronze HDHP regression resolved
-- (53.1% iter0 → 100.0% iter1). Worst remaining = ambetter-silver-87 at 95.2%
-- (still well above any reasonable threshold).
--
-- TRADE-OFF accepted for Stage 3 v1: SBC-specific features in the legacy SBC
-- parser path (DR-3C N=3 cold-start voting + service_catalog admin queue
-- enqueue) are NOT applied when this flag routes SBCs through plan_doc. Both
-- features are orthogonal to extraction quality and can be ported to plan_doc
-- in a follow-up if telemetry shows either is load-bearing in PROD.
--
-- ROLLOUT: OFF by default globally. Andrew flips ON for himself via
-- /admin/flags first (target_type=users, target_users=[andrew.david.ullmann
-- @gmail.com]) to validate end-to-end on PROD traffic. After 7-day soak with
-- no regressions, flip global.
--
-- Mirrors mig 062 (sbc_parser_v1) seeding shape per
-- `feedback_candid_feature_flag_schema`: target_type + (no target_users seeded;
-- defaults to '{}' per mig 023 column default). Admin /admin/flags UI handles
-- target_users[] mutations.

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type)
VALUES (
  'unified_plan_doc_parser_v1',
  false,
  'S93 Stage 3 — unified plan_doc dispatch. When ON for a user, sbc/eoc/plan_document classifications all route through the Haiku-first plan_doc parser (src/lib/plan_doc/) with Stage 3a layout-aware extraction (federal-SBC tabular supplement injects when layout detector emits federal_sbc_8page/federal_sbc_csr_variant). OFF = legacy per-classification routing (sbc → SBC parser via sbc_parser_v1, eoc → EOC parser via eoc_parser_v1, plan_document → plan_doc parser via plan_doc_parser_v2).',
  'global'
)
ON CONFLICT (flag_key) DO NOTHING;
