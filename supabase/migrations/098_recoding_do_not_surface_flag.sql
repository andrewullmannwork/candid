-- S74.6 §H.3 A3 — admin override flag preventing a billing_code_identity row
-- from surfacing in dispute-letter alternative-code recommendations.
--
-- When the dispute-letter peer-code-engine renders alternative codes (D5),
-- admins should be able to suppress patterns that aren't actually useful
-- (e.g., a "won_on_escalation" outcome that was actually an admin-coded
-- write-off, not a true recoding success). Setting this flag TRUE on the
-- identity row in question removes it from peer-code suggestions without
-- needing to delete the row or roll back the historical vote.

ALTER TABLE billing_code_identity
  ADD COLUMN IF NOT EXISTS do_not_surface_in_letters BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN billing_code_identity.do_not_surface_in_letters IS
  'S74.6 §H.3 A3 (Session 89). When TRUE, peer-code-engine excludes this identity row from dispute-letter alternative-code recommendations. Admin override surfaced in /admin/recoding-outcomes. Does NOT affect categorization flywheel or claim_line_items rendering — only dispute-letter suggestion suppression. Default FALSE.';

-- No index needed; the dispute-letter peer-code-engine path already filters
-- by billing_code + billing_code_type which has a composite index, and the
-- exclusion check is per-row in the resolver loop.

-- ── Concern 2: widen promotion_state CHECK to admit 'admin_rejected' ──────
-- §H.1 A1 disambiguation flow: when admin picks a winning slug from the
-- ambiguous pair, the SIBLING row needs a terminal state that preserves
-- forensic info (we don't want to DELETE — audit trail matters) but signals
-- "this candidate was rejected, do not resurface." Mig 094 added
-- 'ambiguous_candidate' to the constraint; this migration adds the
-- 'admin_rejected' terminal state.
--
-- Additive: existing rows in proposed/corroborated/admin_verified/ambiguous_candidate
-- continue to pass.
ALTER TABLE billing_code_identity
  DROP CONSTRAINT IF EXISTS billing_code_identity_promotion_state_check;
ALTER TABLE billing_code_identity
  ADD CONSTRAINT billing_code_identity_promotion_state_check
  CHECK (promotion_state IN (
    'proposed',
    'corroborated',
    'admin_verified',
    'ambiguous_candidate',
    'admin_rejected'
  ));

-- Speed up the A1 admin queue tab — common query is "show me pending queue
-- rows in chronological order." mig 096 has a basic FK index on identity_id
-- but not on (status, created_at). Tiny cardinality (typically <100 pending)
-- so the partial-pending index is enough.
CREATE INDEX IF NOT EXISTS idx_code_identity_queue_pending
  ON code_identity_admin_review_queue (created_at DESC)
  WHERE status = 'pending';
