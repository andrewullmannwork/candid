-- Migration 052: Insurer appeals confirmation log (Phase 6.3)
--
-- Implements Pattern 1 component 2 + 3 tracking from Candid_Data_Patterns.md.
-- Every corroboration event (doc extraction matches existing, user clicks
-- "Looks right" on the verify strip, user submits a correction) writes a row
-- here. Used for:
--   - Stale-detection queries ("how long since anyone confirmed this?")
--   - Flywheel analytics ("how many confirmations has this insurer gotten?")
--   - Rate-limiting ("don't re-prompt the same user within 30 days")

CREATE TABLE IF NOT EXISTS insurer_appeals_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insurer_id UUID NOT NULL REFERENCES insurer_catalog(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('confirmed','proposed_correction','doc_corroboration')),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_iac_insurer_time
  ON insurer_appeals_confirmations(insurer_id, confirmed_at DESC);

CREATE INDEX IF NOT EXISTS idx_iac_user_recent
  ON insurer_appeals_confirmations(user_id, insurer_id, confirmed_at DESC)
  WHERE user_id IS NOT NULL;

COMMENT ON TABLE insurer_appeals_confirmations IS
  'Pattern 1 confirmation log. Tracks every verify-strip click + doc-extraction corroboration for insurer appeals addresses. Drives stale detection + flywheel analytics.';
