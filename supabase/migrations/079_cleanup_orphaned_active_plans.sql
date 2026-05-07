-- Migration 079 — CF-32 data-quality cleanup for orphaned active_insurance_plan_id
-- and users with no active insurance_plans rows
--
-- Session 71 server logs surfaced two pre-existing data integrity issues that
-- the /api/plan/current endpoint papers over via fallbacks but the underlying
-- data state remains degenerate:
--
--   (a) profiles.active_insurance_plan_id pointing to a deleted insurance_plans
--       row (orphaned FK). The runtime fallback in /api/plan/current already
--       handles this gracefully by falling back to the user's latest plan, but
--       the orphaned pointer is junk data that confuses any direct SQL audit.
--
--   (b) Users with at least one insurance_plans row but ALL of them is_active=FALSE.
--       Earlier upload paths somehow deactivated everything for some test users.
--       The fallback in /api/plan/current returns the latest row regardless of
--       is_active, so these users see their plan in the UI — but downstream
--       queries that filter on is_active=true return nothing.
--
-- This migration:
--   1. NULLs orphaned profiles.active_insurance_plan_id values (no FK target).
--   2. For each user with insurance_plans rows but none active, sets their most
--      recent row to is_active=TRUE.
--   3. For each user with profile.active_insurance_plan_id IS NULL but at least
--      one active insurance_plans row, sets profile pointer to the latest active.
--
-- Idempotent: re-running has no effect on already-clean rows. Safe to re-apply.
-- Per Pattern 1 #10: no hard-deletes; we only clear orphaned FKs and reactivate
-- existing rows.

-- ── Step 1: NULL orphaned profile FKs ───────────────────────────────────────
UPDATE profiles
SET active_insurance_plan_id = NULL
WHERE active_insurance_plan_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM insurance_plans WHERE id = profiles.active_insurance_plan_id
  );

-- ── Step 2: Reactivate latest plan for users with all-inactive rows ─────────
WITH latest_inactive_per_user AS (
  SELECT DISTINCT ON (user_id) id, user_id
  FROM insurance_plans
  WHERE user_id IN (
    SELECT user_id
    FROM insurance_plans
    GROUP BY user_id
    HAVING bool_and(is_active = FALSE)
  )
  ORDER BY user_id, created_at DESC
)
UPDATE insurance_plans
SET is_active = TRUE
WHERE id IN (SELECT id FROM latest_inactive_per_user);

-- ── Step 3: Repoint profiles whose active_insurance_plan_id is NULL ─────────
-- (covers both the Step 1 cleared orphans and pre-existing NULLs where the
-- user has insurance_plans rows. After Step 2 above, every user with at least
-- one row has at least one active row.)
WITH latest_active_per_user AS (
  SELECT DISTINCT ON (user_id) id, user_id
  FROM insurance_plans
  WHERE is_active = TRUE
  ORDER BY user_id, created_at DESC
)
UPDATE profiles
SET active_insurance_plan_id = lap.id
FROM latest_active_per_user lap
WHERE profiles.user_id = lap.user_id
  AND profiles.active_insurance_plan_id IS NULL;
