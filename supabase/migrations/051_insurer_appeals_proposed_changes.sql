-- Migration 051: Insurer appeals proposed-changes queue (Phase 6.3)
--
-- Implements Pattern 1 component 4 from Candid_Data_Patterns.md: admin-review
-- queue for mutations to `insurer_catalog.appeals_*`. Every proposed change
-- (doc extraction conflict OR user-submitted correction) lands here and
-- an admin accepts/rejects via /admin/insurer-appeals before the canonical
-- row is touched.
--
-- Hard rule: admin-verified data is NEVER silently overwritten. All mutations
-- flow through this table for explicit review.

CREATE TABLE IF NOT EXISTS insurer_appeals_proposed_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insurer_id UUID NOT NULL REFERENCES insurer_catalog(id) ON DELETE CASCADE,
  proposed_by TEXT NOT NULL CHECK (proposed_by IN ('doc_extraction','user_correction','bot')),
  proposed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  source_excerpt TEXT,
  current_values JSONB NOT NULL,
  proposed_values JSONB NOT NULL,
  confidence NUMERIC(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','superseded')),
  reviewed_by_admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  admin_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_iapc_pending
  ON insurer_appeals_proposed_changes(created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_iapc_insurer
  ON insurer_appeals_proposed_changes(insurer_id, created_at DESC);

COMMENT ON TABLE insurer_appeals_proposed_changes IS
  'Pattern 1 review queue. Every mutation to insurer_catalog.appeals_* flows through here. Admin accepts/rejects; admin-verified data is never silently overwritten.';
