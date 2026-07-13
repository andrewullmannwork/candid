-- =============================================================================
-- MIGRATION 206 — signup funnel: pre-account gate tracking + onboarding steps
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
--
--   "Where in the signup process did we lose them?" (GTM P3). Two blind spots:
--
--   1. PRE-ACCOUNT: someone who enters email+password but quits at the
--      phone-OTP gate never reaches the users table — invisible today. The
--      gates all run inside /api/auth/sync, so the route records step-reached
--      markers server-side: signup_funnel_people, deduped BY PERSON via a
--      one-way sha256 of the Firebase uid (no email/phone/name — retries
--      count once; ON CONFLICT DO NOTHING). Steps: 'attempted' (authenticated
--      signup reached the gates) → 'phone_blocked' (rejected by phone-OTP
--      enforcement) → 'created' (users row inserted). Counting starts at
--      deploy — pre-existing drop-offs were never recorded anywhere.
--
--   2. ONBOARDING (post-account): derivable from artifacts that already exist
--      (insurance_plans row = plan on file; documents rows = card scan /
--      first bill|EOB) — growth_metrics() gains a 'funnel' key; backfills
--      fully. Card-scan is a LOSSY optional artifact (verified on live data)
--      → "plan on file" is the honest plan-setup completion step.
--
--   Admin/test exclusion: growth_metrics() excludes is_admin users from the
--   gate counts by hashing users.firebase_uid in SQL (pgcrypto digest) and
--   anti-joining — same hex-sha256 the route writes.
--
-- WHAT THIS MIGRATION ADDS
--   - pgcrypto extension (digest() for uid hashing at query time)
--   - signup_funnel_people (uid_hash, step, day) — RLS on, no policies;
--     service_role only
--   - record_signup_step(p_uid_hash, p_step) — called by /api/auth/sync via
--     next/server after() (zero added latency), fail-open (errors swallowed)
--   - growth_metrics() REPLACED: + 'signupGates' {attempted, phoneBlocked,
--     created} + 'funnel' {signups, withPlan, withCard, withClaimDoc}
--
-- APPLY ORDER: after 204/205 (replaces the 205 function). BOTH projects
-- (PROD viahl… first, then DEV wdpk…).
--
-- BACKOUT — sync recording is fail-open (missing fn costs nothing); re-apply
--   mig 205's growth_metrics to drop the new keys; DROP TABLE/FUNCTION when
--   convenient. Additive otherwise (Rule 7).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS signup_funnel_people (
  uid_hash text NOT NULL,
  step     text NOT NULL,
  day      date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  PRIMARY KEY (uid_hash, step)
);

COMMENT ON TABLE signup_funnel_people IS
  'GTM P3 (mig 206): pre-account signup-gate steps, one row per (person, step). uid_hash = hex sha256 of the Firebase uid — pseudonymous, no PII. Steps: attempted / phone_blocked / created. Written fail-open by /api/auth/sync; read by growth_metrics().';

ALTER TABLE signup_funnel_people ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE signup_funnel_people FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_signup_step(p_uid_hash text, p_step text)
RETURNS void
LANGUAGE sql
VOLATILE
AS $$
  INSERT INTO signup_funnel_people (uid_hash, step)
  VALUES (left(p_uid_hash, 64), left(p_step, 40))
  ON CONFLICT (uid_hash, step) DO NOTHING;
$$;

REVOKE ALL ON FUNCTION public.record_signup_step(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_signup_step(text, text) TO service_role;

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
eu AS (
  SELECT id, created_at, email_verified,
         COALESCE(first_touch->>'source', '(direct / untagged)') AS source,
         first_touch->>'campaign' AS campaign,
         first_touch->>'landing'  AS landing,
         (first_touch->>'source') IS NOT NULL AS attributed
  FROM public.users
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
  FROM public.documents d
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
),
-- Pre-account gate steps (window by the day the step was first reached),
-- excluding admin/test accounts via the same hex-sha256 the route writes.
admin_hashes AS (
  SELECT encode(digest(firebase_uid, 'sha256'), 'hex') AS uid_hash
  FROM public.users
  WHERE COALESCE(is_admin, false) AND firebase_uid IS NOT NULL
),
gates AS (
  SELECT f.step, count(DISTINCT f.uid_hash)::int AS people
  FROM public.signup_funnel_people f, cutoff c
  WHERE (c.ts IS NULL OR f.day >= c.ts::date)
    AND f.uid_hash NOT IN (SELECT uid_hash FROM admin_hashes)
  GROUP BY f.step
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
  'signupGates', jsonb_build_object(
    'attempted',    COALESCE((SELECT people FROM gates WHERE step = 'attempted'), 0),
    'phoneBlocked', COALESCE((SELECT people FROM gates WHERE step = 'phone_blocked'), 0),
    'created',      COALESCE((SELECT people FROM gates WHERE step = 'created'), 0)
  ),
  'funnel', (
    SELECT jsonb_build_object(
      'signups',      count(*),
      'withPlan',     count(*) FILTER (WHERE id IN (SELECT DISTINCT user_id FROM public.insurance_plans)),
      'withCard',     count(*) FILTER (WHERE id IN (SELECT DISTINCT user_id FROM public.documents WHERE doc_type = 'insurance_card')),
      'withClaimDoc', count(*) FILTER (WHERE id IN (SELECT DISTINCT user_id FROM public.documents WHERE doc_type IN ('itemized_bill', 'eob')))
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
      FROM public.pageview_counts, cutoff c
      WHERE c.ts IS NULL OR day >= c.ts::date
      GROUP BY path ORDER BY sum(count) DESC LIMIT 10
    ) p
  ), '[]'::jsonb)
)
$$;

REVOKE ALL ON FUNCTION public.growth_metrics(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_metrics(text) TO service_role;

COMMIT;
