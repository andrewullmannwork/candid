-- Migration 113: pg_trgm extension + GIN trigram index on canonical_plans.plan_name
--
-- S107 follow-up: /compare search source swap from `plan_catalog` to
-- `canonical_plans`. Today the table holds ~111 rows; cold-start completes
-- this week at ~1,700 rows. At that scale `ILIKE '%query%'` is fine on a seq
-- scan, but a GIN trigram index lets us scale without revisiting later (and
-- supports `similarity()` ranking if we want it).
--
-- Idempotent: both statements use IF NOT EXISTS. Safe to re-apply.
--
-- Pillar tag: P3 (UX/UI) — supports the compare search swap which is
-- user-facing only.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_canonical_plans_plan_name_trgm
  ON canonical_plans
  USING GIN (plan_name gin_trgm_ops);

-- Optional companion: trigram index on insurer_catalog.name for the join-side
-- filter in /api/plan/search. Same scale logic — small today, grows over time.
CREATE INDEX IF NOT EXISTS idx_insurer_catalog_name_trgm
  ON insurer_catalog
  USING GIN (name gin_trgm_ops);
