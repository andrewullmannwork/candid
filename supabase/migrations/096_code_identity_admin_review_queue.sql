-- S74.6 D4 §D.2 — code_identity_admin_review_queue table for ambiguous
-- description-match results. When the Haiku description-match audit rule
-- returns top-1 + second-match within 0.05 score (ambiguous), the audit
-- pipeline writes two candidate `bill_observed_description_match_candidate`
-- source entries on the billing_code_identity row AND enqueues a row here for
-- human disambiguation.
--
-- WHY THIS TABLE EXISTS (the followups Subplan §D.2 assumed mig 087 already
-- created it; it didn't — verified by grep against supabase/migrations/).
--
-- The admin UI A1 (deferred to S89) will SELECT pending rows, render the
-- top-2 candidates with their Haiku scores, and POST to a resolver endpoint
-- that calls promote_with_slug() on the chosen slug.
--
-- Schema mirrors concept_admin_review_queue (mig 061) + service_catalog_admin_review_queue
-- (mig 065) for admin tooling consistency.

CREATE TABLE IF NOT EXISTS code_identity_admin_review_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The ambiguous identity row that triggered this queue entry.
  identity_id UUID NOT NULL REFERENCES billing_code_identity(id) ON DELETE CASCADE,

  -- The user whose bill produced the ambiguity (for forensics + per-user dedup).
  proposed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  -- The line item on the user's bill that triggered this — used by A1 UI to
  -- show "this line: 99214 'OFFICE VISIT'" alongside the candidate slugs.
  -- Nullable because line items may not yet exist at audit time on some paths.
  source_line_item_id UUID REFERENCES claim_line_items(id) ON DELETE SET NULL,

  -- Top-K candidate slugs + scores from the Haiku description-match call.
  -- Stored as a JSONB array of `{ slug: string, score: number }` objects.
  -- A1 UI renders these as the disambiguation choice list.
  candidate_slugs JSONB NOT NULL,

  -- Workflow state (mirrors mig 061 + mig 065).
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved', 'rejected', 'needs_more_info')),

  -- Resolution (populated when admin picks a winning slug).
  resolved_slug TEXT,
  resolved_by_admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  admin_notes TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotency: same (identity, user) ambiguity reported across multiple
  -- bills collapses to one queue row. Re-runs no-op via INSERT-on-empty
  -- check in recordAmbiguousCandidate().
  CONSTRAINT code_identity_review_queue_unique_per_user
    UNIQUE (identity_id, proposed_by_user_id)
);

-- Partial index — most admin queries are "show me pending"
CREATE INDEX IF NOT EXISTS idx_code_identity_review_queue_pending
  ON code_identity_admin_review_queue(created_at DESC)
  WHERE status = 'pending';

-- Per-identity lookups (admin "show all ambiguities on this identity row")
CREATE INDEX IF NOT EXISTS idx_code_identity_review_queue_identity
  ON code_identity_admin_review_queue(identity_id, created_at DESC);

-- Auto-update timestamp via the shared helper from mig 003 + 009.
CREATE TRIGGER code_identity_review_queue_updated_at
  BEFORE UPDATE ON code_identity_admin_review_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- RLS — admin-only SELECT/UPDATE. Audit pipeline writes via service role
-- (bypasses RLS).
ALTER TABLE code_identity_admin_review_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY code_identity_review_queue_admin_select ON code_identity_admin_review_queue
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_admin = true)
  );

CREATE POLICY code_identity_review_queue_admin_update ON code_identity_admin_review_queue
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_admin = true)
  );

COMMENT ON TABLE code_identity_admin_review_queue IS
  'S74.6 D4 §D.2 (Session 88). Admin disambiguation queue for billing_code_identity rows in promotion_state=ambiguous_candidate (mig 094 widened CHECK). One row per (identity, user) ambiguity — same code+signature surfacing as ambiguous across multiple bills from the same user collapses via UNIQUE. Audit pipeline writes via service role on confident-but-ambiguous description-match (top score >=0.85 AND gap <0.05). A1 admin UI (deferred to S89) SELECTs pending rows, presents top-2 candidate slugs with Haiku scores, and resolves via promote_with_slug() on the chosen slug. RLS admin-only; service-role writes bypass.';
