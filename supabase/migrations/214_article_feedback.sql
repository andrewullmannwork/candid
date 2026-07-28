-- =============================================================================
-- MIGRATION 214 — article_feedback: "was this article helpful?" votes on /learn
-- (S290 — Andrew E2E item 3)
-- =============================================================================
--
-- One row per thumbs-up/down on a /learn article. Anonymous votes allowed
-- (marketing surface, public endpoint); when the reader is signed in the API
-- verifies the Firebase token server-side and stamps user_id + email — the
-- client can never assert identity. Writes go through
-- POST /api/learn/feedback with the service-role client ONLY.
--
-- Not canonical data; user-initiated event capture (Rule #10 user-scoped).
-- Dedupe is client-side (localStorage, one vote per article per browser);
-- rows are append-only and analyzed in aggregate.
--
-- APPLY (Studio, one paste): strip comments before pasting (Studio
-- silent-failure gotcha) + run the verify SELECTs after.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS article_feedback;
-- =============================================================================

CREATE TABLE IF NOT EXISTS article_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_slug text NOT NULL,
  helpful boolean NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT article_feedback_slug_shape CHECK (article_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(article_slug) <= 120)
);

CREATE INDEX IF NOT EXISTS idx_article_feedback_slug_created
  ON article_feedback (article_slug, created_at DESC);

ALTER TABLE article_feedback ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE article_feedback FROM anon, authenticated;

COMMENT ON TABLE article_feedback IS
  'S290 — /learn "was this helpful" votes. Service-role writes only (POST /api/learn/feedback); anonymous allowed; user_id/email stamped server-side from a verified Firebase token. RLS enabled with no policies = deny all non-service access.';

-- =============================================================================
-- VERIFY (run after apply; expectations in brackets):
-- 1) Table + RLS:
--    SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname = 'article_feedback';                       -- [1 row, t]
-- 2) No anon/authenticated grants:
--    SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name = 'article_feedback'
--      AND grantee IN ('anon','authenticated');                -- [0 rows]
-- 3) Index:
--    SELECT indexname FROM pg_indexes
--    WHERE tablename = 'article_feedback';                     -- [pkey + idx_article_feedback_slug_created]
-- =============================================================================
