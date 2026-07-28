-- =============================================================================
-- MIGRATION 215 — guide_feedback_metrics(win): /learn thumbs aggregates for
-- /admin/growth (S290 — Andrew E2E item 4 follow-through)
-- =============================================================================
--
-- ADDITIVE companion to the mig-205 growth_metrics() RPC — deliberately a
-- separate function rather than CREATE OR REPLACE on the live one (no risk of
-- drifting the deployed body). Same conventions: SQL-side aggregation (the
-- v1.1 row-cap lesson), is_admin voters excluded ("founder/test activity is
-- not growth" — anonymous votes kept), aggregates only.
--
-- APPLY (Studio, one paste): strip comments before pasting + run verify.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS guide_feedback_metrics(text);
-- =============================================================================

CREATE OR REPLACE FUNCTION guide_feedback_metrics(win text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH cutoff AS (
    SELECT CASE win
      WHEN '7d' THEN now() - interval '7 days'
      WHEN '30d' THEN now() - interval '30 days'
      ELSE NULL
    END AS ts
  ),
  votes AS (
    SELECT af.article_slug, af.helpful
    FROM article_feedback af, cutoff c
    WHERE (c.ts IS NULL OR af.created_at >= c.ts)
      AND NOT EXISTS (
        SELECT 1 FROM users u WHERE u.id = af.user_id AND u.is_admin
      )
  ),
  per_article AS (
    SELECT
      article_slug,
      count(*) FILTER (WHERE helpful) AS up,
      count(*) FILTER (WHERE NOT helpful) AS down
    FROM votes
    GROUP BY article_slug
    ORDER BY count(*) DESC, article_slug ASC
  )
  SELECT jsonb_build_object(
    'totalUp',   COALESCE((SELECT count(*) FROM votes WHERE helpful), 0),
    'totalDown', COALESCE((SELECT count(*) FROM votes WHERE NOT helpful), 0),
    'articles',  COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
         'slug', article_slug, 'up', up, 'down', down))
       FROM per_article),
      '[]'::jsonb
    )
  );
$$;

-- Default-privileges hygiene: lock to service_role (route enforces admin).
REVOKE EXECUTE ON FUNCTION guide_feedback_metrics(text) FROM anon, authenticated;

-- =============================================================================
-- VERIFY (run after apply):
-- 1) SELECT guide_feedback_metrics('all');
--    -- [jsonb with totalUp/totalDown/articles; on DEV right now expect
--    --  totalUp=1 (how-to-fight…), totalDown=1 (how-to-negotiate…)]
-- 2) SELECT count(*) FROM information_schema.routine_privileges
--    WHERE routine_name='guide_feedback_metrics'
--      AND grantee IN ('anon','authenticated');                 -- [0]
-- =============================================================================
