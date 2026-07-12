-- =============================================================================
-- MIGRATION 204 — pageview_counts: server-side page-visit counting (GTM P3)
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
--
--   The /admin/growth dashboard needs "which pages are visited most" WITHOUT
--   client-side analytics (S199 rule: no third-party trackers, nothing on CHD
--   pages). Solution: middleware counts page requests server-side via a
--   fire-and-forget RPC — path-only daily aggregates, NO user linkage, no
--   cookie, no IP, no user-agent stored. A count of "/claim was requested N
--   times today" carries no consumer-health data about anybody.
--
-- WHAT THIS MIGRATION ADDS
--
--   pageview_counts (path, day, count) — PK (path, day); one row per path per
--     UTC day, upserted by increment_pageview().
--   increment_pageview(p_path) — VOLATILE upsert, called by src/middleware.ts
--     via PostgREST with the service-role key (event.waitUntil, fail-open:
--     middleware swallows all errors; a missing table/function costs nothing).
--
--   Locked down per the grants discipline: RLS enabled with NO policies +
--   REVOKE from anon/authenticated/PUBLIC → service_role only (Supabase
--   auto-grants EXECUTE on new public functions otherwise).
--
-- BACKOUT — middleware is fail-open; DROP FUNCTION public.increment_pageview,
--   then the table when convenient. Additive otherwise (Rule 7).

BEGIN;

CREATE TABLE IF NOT EXISTS pageview_counts (
  path  text   NOT NULL,
  day   date   NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (path, day)
);

COMMENT ON TABLE pageview_counts IS
  'GTM P3 (mig 204): server-side daily pageview counts by path. Path-only aggregates — no user linkage, no PII/CHD. Written by increment_pageview() from middleware (fire-and-forget); read by growth_metrics() for /admin/growth.';

ALTER TABLE pageview_counts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE pageview_counts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.increment_pageview(p_path text)
RETURNS void
LANGUAGE sql
VOLATILE
AS $$
  INSERT INTO pageview_counts (path, day, count)
  VALUES (left(coalesce(p_path, '/'), 160), (now() AT TIME ZONE 'utc')::date, 1)
  ON CONFLICT (path, day) DO UPDATE SET count = pageview_counts.count + 1;
$$;

REVOKE ALL ON FUNCTION public.increment_pageview(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_pageview(text) TO service_role;

COMMIT;
