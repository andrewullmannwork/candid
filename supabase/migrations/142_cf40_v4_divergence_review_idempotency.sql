-- =============================================================================
-- MIGRATION 142 — CF-40 v4 Layer 3(b): divergence-review idempotency + scale fix (Ing-D.0d)
-- =============================================================================
--
-- WHY (Ing-D.0d — pre-launch backend hardening, Session 160):
--   D.0d adds the Layer-3(b) minority-candidate router: when the supermajority
--   evaluation (promotion-evaluator.ts) finds a dissenting identity-value tuple,
--   v3 silently dropped it ("outlier elimination"); v4 routes it to
--   canonical_divergence_review for admin disambiguation (plan variant / adversarial
--   / stale / Haiku noise). Unlike the Layer-4 rapid-change router (which also writes
--   this table but fires RARELY), the minority router fires on EVERY parse event that
--   has a vote split — high frequency at scale — and the QStash parse pipeline RETRIES
--   events. A naive insert therefore fills the admin queue with duplicate pending rows
--   for the same (canonical, doc_type, field, value), which makes the queue unusable
--   (cannot tell 1 dissenter from 1 dissenter re-counted N×).
--
--   The fix is DB-ENFORCED idempotency: one live PENDING row per distinct divergence,
--   refreshed (weight/users grow) rather than duplicated. The shared writer
--   (src/lib/parser/cf40-v4/divergence-review.ts) does INSERT and, on the 23505
--   unique-violation, UPDATE-in-place — race-safe (two concurrent workers: one wins
--   the insert, the other 23505s → refreshes) and retry-safe. This needs a PARTIAL
--   unique index keyed on a stable text representation of the dissenting value.
--   (PostgREST .upsert() cannot infer a PARTIAL index as a conflict arbiter, which is
--   why the app uses insert-then-23505-update against this index rather than upsert.)
--
-- WHAT THIS MIGRATION ADDS / CHANGES (all additive or widening; no data change —
-- the table is EMPTY in PROD because cf40_v4_algorithm is OFF):
--   1. canonical_divergence_review.minority_value_key TEXT (nullable) — a stable
--      text key for the dissenting per-field value ('∅' for NULL, else the value as
--      text). The idempotency arbiter component the JSONB minority_value cannot
--      cheaply provide. The application always populates it on both writers (Layer-3b
--      minority + Layer-4 rapid-change); left nullable so the ADD is metadata-only.
--   2. canonical_divergence_review.updated_at TIMESTAMPTZ DEFAULT now() — refresh
--      timestamp bumped when an existing pending row is re-touched by the upsert.
--   3. PARTIAL UNIQUE INDEX on (canonical_plan_id, document_type, field_name,
--      minority_value_key) WHERE status='pending' — the dedup enforcement. Scoped to
--      pending so a re-emerged divergence whose prior row was already disposed
--      (confirmed/rejected/deferred) opens a FRESH pending row (admin sees it
--      resurfaced) instead of silently reopening a closed disposition.
--   4. WIDEN minority_weight + total_weight from NUMERIC(6,3) → NUMERIC(14,3)
--      (scalability fix found during D.0d build). total_weight is a SUM of per-user
--      effective weights (≤3.0 each over DISTINCT users); NUMERIC(6,3) overflows at
--      999.999 — i.e. at ~1K total weight (small scale, 10K uploads), well inside the
--      documented medium/large targets (10K–1M+ users). The minority router writes
--      this column, so an un-widened column is a latent overflow landmine that fires
--      exactly when the flywheel succeeds. Widening now (empty table) is free; later
--      (populated, at scale) is a type change under load. The generated minority_share
--      column is DROPped + re-ADDed (a generated column blocks ALTER TYPE on its
--      inputs); share is a ratio in [0,1] so its own precision is unchanged.
--
-- ROLLBACK:
--   All additive/widening. cf40_v4_algorithm is OFF in PROD → no Layer-3b/Layer-4
--   code path writes this table → 0 PROD rows use any of these. Rollback =
--   DROP INDEX uq_canonical_divergence_review_pending +
--   ALTER TABLE canonical_divergence_review
--     DROP COLUMN minority_value_key, DROP COLUMN updated_at +
--   (optional) narrow the weight columns back to NUMERIC(6,3). Safe precisely because
--   no PROD rows exist.
--
-- DEPENDENCIES: mig 086 (canonical_divergence_review table + the generated
--   minority_share column + the non-unique idx_..._pending ordering index, both
--   preserved/recreated here).
-- =============================================================================

BEGIN;

-- ── 1. minority_value_key — the idempotency arbiter component ─────────────────
-- ADD COLUMN ... NULL is metadata-only in Postgres (no table rewrite).
ALTER TABLE canonical_divergence_review
  ADD COLUMN IF NOT EXISTS minority_value_key TEXT;

COMMENT ON COLUMN canonical_divergence_review.minority_value_key IS
  'Ing-D.0d (mig 142). Stable text key for the dissenting per-field value — ''∅'' for NULL, else the scalar value as text. The idempotency arbiter component (with canonical_plan_id, document_type, field_name) for the partial-unique dedup index; the JSONB minority_value_jsonb cannot cheaply serve as a unique key. Populated by both writers (Layer-3b minority router + Layer-4 rapid-change). Nullable so the ADD is metadata-only; the application invariant is that it is always set.';

-- ── 2. updated_at — upsert refresh timestamp ─────────────────────────────────
ALTER TABLE canonical_divergence_review
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON COLUMN canonical_divergence_review.updated_at IS
  'Ing-D.0d (mig 142). Bumped when the shared upsert refreshes an existing pending row in place (weight/users grew as more uploads converged on the same dissenting value). created_at stays the first-seen time.';

-- ── 3. partial unique index — the dedup enforcement ──────────────────────────
-- Scoped WHERE status='pending': only ONE live pending row per distinct divergence;
-- disposed rows (confirmed/rejected/deferred) do not block a re-emergence.
CREATE UNIQUE INDEX IF NOT EXISTS uq_canonical_divergence_review_pending
  ON canonical_divergence_review (canonical_plan_id, document_type, field_name, minority_value_key)
  WHERE status = 'pending';

-- ── 4. widen weight columns (scalability) — drop+recreate the generated share ──
-- A generated column blocks ALTER TYPE of its inputs, so drop it, widen the bases,
-- recreate it. Empty table → no data loss; column order is irrelevant (named access).
ALTER TABLE canonical_divergence_review DROP COLUMN IF EXISTS minority_share;

ALTER TABLE canonical_divergence_review
  ALTER COLUMN minority_weight TYPE NUMERIC(14, 3),
  ALTER COLUMN total_weight TYPE NUMERIC(14, 3);

ALTER TABLE canonical_divergence_review
  ADD COLUMN minority_share NUMERIC(4, 3) GENERATED ALWAYS AS (
    CASE WHEN total_weight > 0 THEN minority_weight / total_weight ELSE 0 END
  ) STORED;

COMMENT ON COLUMN canonical_divergence_review.minority_weight IS
  'Ing-D.0d (mig 142, widened NUMERIC(6,3)→(14,3)). The dissenting value''s magnitude: summed per-user effective weight (Layer-3b) or converging-user count (Layer-4 rapid-change). Widened so total_weight (a sum over distinct users, ≤3.0 each) cannot overflow at small+ scale.';

COMMENT ON COLUMN canonical_divergence_review.total_weight IS
  'Ing-D.0d (mig 142, widened NUMERIC(6,3)→(14,3)). Total magnitude across all candidates (Σ per-user effective weight, or total converging+baseline users). NUMERIC(6,3) overflowed at 999.999 (~10K uploads); (14,3) covers 1M+ users × 3.0.';

COMMIT;
