-- =============================================================================
-- MIGRATION 077 — Benefits Comparison feature flag (S70)
-- =============================================================================
--
-- Seeds the `benefits_comparison_v1` row in `feature_flag_rules` so the
-- Candid Compare surface (`/compare` page + `/api/plan/compare` endpoint +
-- dashboard "Compare plans" entry card) can be flipped global ON post-deploy
-- without a code change. Default OFF so the PR can merge to main, deploy,
-- and verify end-to-end before becoming visible to users.
--
-- WHY:
--   S70 (Pillar P3 per [[plans/mvp_friday_master]] §S70 + [[Candid_10k]] §3.1)
--   ships the NEW Benefits Comparison sub-service — up to 3 plans side-by-side
--   across top-line metrics (premium / OOP max / deductible) + service breadth
--   ("Plan A covers 48 services; Plan B covers 53") + service depth ("Plan A:
--   $30 PCP copay; Plan B: $40"). Two entry paths:
--     1. Search & pick — type plan names, autocomplete from canonical_plans
--        (re-uses /api/plan/search trigram + ILIKE matcher).
--     2. Multi-upload — drag-drop up to 3 SBC/plan_document PDFs, each parsed
--        through the existing /api/documents/upload pipeline; compare renders
--        from the resulting insurance_plans rows.
--
--   Surface gates on email_verified=TRUE (carrot for verification) +
--   phone_verified=TRUE (S69 baseline). Renders DecoratedValue<T> via Phase 4.0
--   consumer_read_filter_v1 decoration when ON.
--
-- ROLLOUT PLAN:
--   1. Merge this migration with default OFF.
--   2. Deploy code — at this stage flag OFF means /compare returns 404 + the
--      dashboard card is hidden + the API endpoint returns 503.
--   3. User-tests via local dev with flag manually flipped for their account.
--   4. Flip flag global ON post-PROD-smoke:
--      UPDATE feature_flag_rules SET enabled=true
--        WHERE flag_key='benefits_comparison_v1';
--
-- ROLLBACK:
--   Flip flag OFF — surface vanishes server-side and client-side; existing
--   /plan + /upload flows unaffected. Removal of the row is forbidden per
--   Pattern 1 #10 hard-delete prohibition.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'benefits_comparison_v1',
  false,
  'S70 (Session 70). Candid Compare surface — /compare page + /api/plan/compare endpoint + dashboard entry card. Up to 3 plans side-by-side via search-by-name OR multi-upload (1-3 SBC/plan_document PDFs through existing /api/documents/upload). Email-verified + phone-verified gated. Renders DecoratedValue<T> via Phase 4.0 consumer_read_filter_v1 decoration. When OFF, /compare returns 404 + API returns 503 + dashboard card hidden. Flip global ON post-deploy after verifying end-to-end smoke.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
