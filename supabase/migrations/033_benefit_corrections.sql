-- Migration 033: Benefit corrections system
-- Allows users to flag incorrect benefit values and admins to review/apply corrections.
-- Community voting deferred to T3.1 (multi-user notifications).

-- Feature flag (disabled by default)
INSERT INTO feature_flag_rules (flag_key, scope, enabled, description)
VALUES ('benefit_corrections', 'global', false, 'Enable benefit correction submissions on plan page')
ON CONFLICT (flag_key) DO NOTHING;

-- Corrections table: tracks user-submitted corrections to plan benefit data
CREATE TABLE IF NOT EXISTS benefit_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What's being corrected
  insurance_plan_id UUID REFERENCES insurance_plans(id) ON DELETE SET NULL,
  canonical_plan_id UUID REFERENCES canonical_plans(id) ON DELETE SET NULL,
  service_slug TEXT NOT NULL,
  -- Correction details
  field TEXT NOT NULL CHECK (field IN ('copay', 'coinsurance', 'covered', 'prior_auth', 'deductible_applies', 'annual_limit', 'other')),
  old_value TEXT, -- JSON-encoded original value
  proposed_value TEXT NOT NULL, -- JSON-encoded proposed value
  notes TEXT, -- Free-text explanation from user
  -- Evidence
  evidence_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  -- Status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'applied')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_benefit_corrections_user ON benefit_corrections(user_id);
CREATE INDEX IF NOT EXISTS idx_benefit_corrections_canonical ON benefit_corrections(canonical_plan_id);
CREATE INDEX IF NOT EXISTS idx_benefit_corrections_status ON benefit_corrections(status);
CREATE INDEX IF NOT EXISTS idx_benefit_corrections_service ON benefit_corrections(service_slug);

-- No RLS — access controlled at API level via Firebase auth (same pattern as other tables).
-- Server-side Supabase client bypasses RLS; auth.uid() does not work with Firebase.

-- Comment
COMMENT ON TABLE benefit_corrections IS 'User-submitted corrections to plan benefit data. Admin-only review for now; community voting deferred to T3.1.';
