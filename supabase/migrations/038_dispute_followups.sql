-- Migration 038: Dispute follow-ups + feedback loop
-- Phase 2A of Paid Candid Claim: timed follow-ups for dispute outcome tracking
-- Also includes Phase 2C escalation columns (same table, avoids future ALTER)

-- 1. dispute_followups table
CREATE TABLE IF NOT EXISTS dispute_followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES dispute_outcomes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Follow-up classification
  followup_type TEXT NOT NULL CHECK (followup_type IN (
    'initial_30d', 'reprompt_14d', 'final',
    'post_escalation_60d', 'post_escalation_reprompt_30d'
  )),
  due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'shown', 'dismissed', 'acted'
  )),

  -- Phase 2C: escalation tracking
  escalation_type TEXT CHECK (escalation_type IN ('case', 'small_claims', 'external_appeal')),

  -- Metadata for flexibility
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_followups_user_due ON dispute_followups(user_id, due_date);
CREATE INDEX IF NOT EXISTS idx_followups_status ON dispute_followups(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_followups_dispute ON dispute_followups(dispute_id);

-- 2. Feature flag (disabled by default)
INSERT INTO feature_flag_rules (flag_key, enabled, target_type, target_value, description)
VALUES ('dispute_feedback_loop', false, 'global', NULL, 'Timed follow-ups for dispute outcome tracking (30-day initial, 14-day reprompt)')
ON CONFLICT (flag_key) DO NOTHING;

-- 3. Phase 2C prep: add escalation status values to dispute_outcomes
-- The status column uses a CHECK constraint — we need to replace it
-- First check if the constraint exists and drop + re-create with new values
DO $$
BEGIN
  -- Add won_on_escalation and settled_on_escalation if constraint allows
  -- dispute_outcomes.status is either free text or has a CHECK constraint
  -- Safe approach: try ALTER, catch if already done
  BEGIN
    ALTER TABLE dispute_outcomes DROP CONSTRAINT IF EXISTS dispute_outcomes_status_check;
  EXCEPTION WHEN undefined_object THEN
    NULL;
  END;
END $$;

-- Re-add CHECK with expanded values (including escalation statuses)
ALTER TABLE dispute_outcomes
  ADD CONSTRAINT dispute_outcomes_status_check
  CHECK (status IN ('filed', 'in_progress', 'won', 'lost', 'settled', 'withdrawn', 'won_on_escalation', 'settled_on_escalation'));
