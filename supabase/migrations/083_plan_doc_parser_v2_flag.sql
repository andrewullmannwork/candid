-- =============================================================================
-- MIGRATION 083 — Plan_doc Haiku-first parser feature flag (S72)
-- =============================================================================
--
-- Seeds the `plan_doc_parser_v2` row in `feature_flag_rules` so the new
-- Haiku-first plan_doc parser shipped in S72 can be flipped global ON post-deploy
-- without a code change. Default OFF so the PR can merge to main, deploy, and
-- verify end-to-end on dev server before becoming the default plan_document
-- dispatch path.
--
-- WHY (S72-PLAN-DOC user direction Session 75):
--   Legacy `parsePlanDocument()` regex parser at src/lib/plan/plan-doc-parser.ts
--   has ~49% recall — gates dispute-letter cite-grade resolution + CF-19
--   root-cause path (smart-skip falls back when plan-identity Haiku misses →
--   page-level upload prompt fires). S72 ships Haiku-first replacement per
--   Phase 3.1A architectural template (EOC parser; ~80%+ recall on its native
--   sections).
--
--   Per Q-S72-2 (b) LOCK: when this flag is ON, EOC parser's plan-identity
--   reuse at eoc/parser.ts:23 ALSO routes through Haiku-first (free recall lift
--   from ~49% → ~80%+). Mitigation per Subplan §5: Blue Shield Silver 70 PPO
--   EOC fixture regression check before considering ship-ready.
--
-- ROLLOUT PLAN:
--   1. Merge this migration with default OFF.
--   2. Deploy code (NEW src/lib/plan_doc/ scaffolding + parsePlanDocument
--      becomes flag-gated dispatcher + 3 parsers write canonical_haiku_extractions).
--      At this stage flag OFF means legacy regex is the default; new path runs
--      only when flag manually toggled for admin user.
--   3. User-tests via local dev with flag manually flipped for their account.
--   4. EOC plan-identity regression check on Blue Shield Silver 70 PPO fixture
--      (per Subplan §5).
--   5. Flip flag global ON post-PROD-smoke (folded into S77 PROD E2E batch
--      per Session 75 user direction):
--      UPDATE feature_flag_rules SET enabled=true
--        WHERE flag_key='plan_doc_parser_v2';
--
-- ROLLBACK:
--   Flip flag OFF — server reverts to legacy `parsePlanDocumentRegex` for both
--   plan_doc dispatch + EOC reuse. The new Haiku-first code paths still exist
--   (no code revert needed). Removal of the row is forbidden per Pattern 1 #10
--   hard-delete prohibition.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'plan_doc_parser_v2',
  false,
  'S72 (Session 75). Plan_doc Haiku-first parser per Phase 3.1A architectural template (replaces legacy ~49% recall regex at src/lib/plan/plan-doc-parser.ts:parsePlanDocument). When OFF, parsePlanDocument routes to legacy parsePlanDocumentRegex; when ON, routes to NEW parsePlanDocumentHaiku (per-section dispatcher + Haiku-discovery fallback + Pattern P-8 verification + cost cap). Per Q-S72-2 (b) LOCK: EOC parser plan-identity reuse at eoc/parser.ts:23 ALSO routes through Haiku-first when flag ON (free recall lift). Cross-parser scope: NEW src/lib/plan_doc/ + canonical_haiku_extractions writes from SBC + EOC + plan_doc + dispute-letter cite-grade resolution fallback + OON per-service + plan-specific access-instructions extraction. Flip global ON post-deploy after dev smoke + EOC fixture regression check (Subplan §5).',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
