-- =============================================================================
-- MIGRATION 205 — growth_metrics(): SQL aggregation for /admin/growth (GTM P3)
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
--
--   1. FIXES a live defect: the shipped route aggregated in TS over table
--      reads that PostgREST silently caps at 1,000 rows (documents is already
--      at ~2,587 → uploads undercounted; the route's 20k limit + rowCapHit
--      guard never see the cap). SQL aggregation has no row ceiling.
--   2. Founder/test pollution: ~all current documents belong to admin
--      accounts. Every metric here EXCLUDES users with is_admin = true —
--      founder activity is not growth.
--   3. Carries the v1.1 dashboard additions: verified signups, bills vs
--      plan-docs upload split, top first-touch landing pages, and top pages
--      by server-side pageviews (pageview_counts, mig 204 — apply 204 FIRST).
--
-- WHAT THIS MIGRATION ADDS
--
--   growth_metrics(win) → jsonb, win ∈ '7d' | '30d' | 'all' (else 30d).
--   Shape (camelCase, mirrors the /api/admin/growth-metrics response):
--     { totals:    { signups, verified, uploaders, uploads, bills, planDocs,
--                    otherDocs, attributedSignups, attributedPct },
--       bySource:  [{ source, signups, verified, uploaders, uploads, bills, planDocs }],
--       byCampaign:[{ campaign, source, signups }],            -- top 10
--       weekly:    [{ weekStart, signups, uploads, topSource }], -- last 8 wks
--       topLanding:[{ landing, signups }],                     -- top 10, attributed only
--       topPages:  [{ path, views }] }                         -- top 10, mig-204 counts
--
--   Doc families: bills = itemized_bill + eob (Claim pillar);
--   planDocs = sbc + plan_document + eoc + insurance_card (Compare/Benefits);
--   anything else (incl. NULL doc_type) = otherDocs.
--
--   STABLE, read-only; locked to service_role (REVOKE anon/authenticated —
--   Supabase auto-grants EXECUTE on new public functions otherwise). Called
--   only by /api/admin/growth-metrics behind requireAdmin.
--
-- BACKOUT — DROP FUNCTION public.growth_metrics(text). Route degrades to 500
--   on /admin/growth only (admin surface); no user-facing impact.

BEGIN;

CREATE OR REPLACE FUNCTION public.growth_metrics(win text DEFAULT '30d')
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
WITH cutoff AS (
  SELECT CASE win
           WHEN '7d'  THEN now() - interval '7 days'
           WHEN 'all' THEN NULL
           ELSE now() - interval '30 days'
         END AS ts
),
-- Eligible users: founder/admin/test accounts excluded from ALL metrics.
eu AS (
  SELECT id, created_at, email_verified,
         COALESCE(first_touch->>'source', '(direct / untagged)') AS source,
         first_touch->>'campaign' AS campaign,
         first_touch->>'landing'  AS landing,
         (first_touch->>'source') IS NOT NULL AS attributed
  FROM users
  WHERE NOT COALESCE(is_admin, false)
),
wu AS (
  SELECT eu.* FROM eu, cutoff c WHERE c.ts IS NULL OR eu.created_at >= c.ts
),
ed AS (
  SELECT d.user_id, d.created_at, eu.source,
         CASE
           WHEN d.doc_type IN ('itemized_bill', 'eob') THEN 'bills'
           WHEN d.doc_type IN ('sbc', 'plan_document', 'eoc', 'insurance_card') THEN 'plan_docs'
           ELSE 'other'
         END AS family
  FROM documents d
  JOIN eu ON eu.id = d.user_id
),
wd AS (
  SELECT ed.* FROM ed, cutoff c WHERE c.ts IS NULL OR ed.created_at >= c.ts
),
src_signups AS (
  SELECT source,
         count(*)::int AS signups,
         count(*) FILTER (WHERE email_verified)::int AS verified
  FROM wu GROUP BY source
),
src_docs AS (
  SELECT source,
         count(*)::int AS uploads,
         count(*) FILTER (WHERE family = 'bills')::int AS bills,
         count(*) FILTER (WHERE family = 'plan_docs')::int AS plan_docs,
         count(DISTINCT user_id)::int AS uploaders
  FROM wd GROUP BY source
),
by_source AS (
  SELECT source,
         COALESCE(s.signups, 0)   AS signups,
         COALESCE(s.verified, 0)  AS verified,
         COALESCE(d.uploaders, 0) AS uploaders,
         COALESCE(d.uploads, 0)   AS uploads,
         COALESCE(d.bills, 0)     AS bills,
         COALESCE(d.plan_docs, 0) AS plan_docs
  FROM src_signups s FULL JOIN src_docs d USING (source)
),
weeks AS (
  SELECT (date_trunc('week', now()) - make_interval(weeks => i))::date AS wk
  FROM generate_series(7, 0, -1) AS i
),
wk_top AS (
  SELECT DISTINCT ON (wk) wk, source
  FROM (
    SELECT date_trunc('week', created_at)::date AS wk, source, count(*) AS c
    FROM eu GROUP BY 1, 2
  ) t
  ORDER BY wk, c DESC, source
)
SELECT jsonb_build_object(
  'totals', (
    SELECT jsonb_build_object(
      'signups',           count(*),
      'verified',          count(*) FILTER (WHERE email_verified),
      'attributedSignups', count(*) FILTER (WHERE attributed),
      'attributedPct',     CASE WHEN count(*) = 0 THEN 0
                                ELSE round(100.0 * count(*) FILTER (WHERE attributed) / count(*)) END,
      'uploaders', (SELECT count(DISTINCT user_id) FROM wd),
      'uploads',   (SELECT count(*) FROM wd),
      'bills',     (SELECT count(*) FROM wd WHERE family = 'bills'),
      'planDocs',  (SELECT count(*) FROM wd WHERE family = 'plan_docs'),
      'otherDocs', (SELECT count(*) FROM wd WHERE family = 'other')
    ) FROM wu
  ),
  'bySource', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'source', source, 'signups', signups, 'verified', verified,
             'uploaders', uploaders, 'uploads', uploads,
             'bills', bills, 'planDocs', plan_docs)
           ORDER BY signups DESC, uploads DESC)
    FROM by_source
  ), '[]'::jsonb),
  'byCampaign', COALESCE((
    SELECT jsonb_agg(row ORDER BY signups DESC) FROM (
      SELECT jsonb_build_object('campaign', campaign, 'source', source,
                                'signups', count(*)::int) AS row,
             count(*) AS signups
      FROM wu WHERE campaign IS NOT NULL
      GROUP BY campaign, source
      ORDER BY count(*) DESC LIMIT 10
    ) c
  ), '[]'::jsonb),
  'weekly', (
    SELECT jsonb_agg(jsonb_build_object(
             'weekStart', to_char(w.wk, 'YYYY-MM-DD'),
             'signups',   COALESCE(s.n, 0),
             'uploads',   COALESCE(u.n, 0),
             'topSource', COALESCE(t.source, '—'))
           ORDER BY w.wk)
    FROM weeks w
    LEFT JOIN (SELECT date_trunc('week', created_at)::date wk, count(*)::int n FROM eu GROUP BY 1) s ON s.wk = w.wk
    LEFT JOIN (SELECT date_trunc('week', created_at)::date wk, count(*)::int n FROM ed GROUP BY 1) u ON u.wk = w.wk
    LEFT JOIN wk_top t ON t.wk = w.wk
  ),
  'topLanding', COALESCE((
    SELECT jsonb_agg(row ORDER BY signups DESC) FROM (
      SELECT jsonb_build_object('landing', landing, 'signups', count(*)::int) AS row,
             count(*) AS signups
      FROM wu WHERE landing IS NOT NULL
      GROUP BY landing ORDER BY count(*) DESC LIMIT 10
    ) l
  ), '[]'::jsonb),
  'topPages', COALESCE((
    SELECT jsonb_agg(row ORDER BY views DESC) FROM (
      SELECT jsonb_build_object('path', path, 'views', sum(count)::int) AS row,
             sum(count) AS views
      FROM pageview_counts, cutoff c
      WHERE c.ts IS NULL OR day >= c.ts::date
      GROUP BY path ORDER BY sum(count) DESC LIMIT 10
    ) p
  ), '[]'::jsonb)
)
$$;

REVOKE ALL ON FUNCTION public.growth_metrics(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_metrics(text) TO service_role;

COMMIT;
