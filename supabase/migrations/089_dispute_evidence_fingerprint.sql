-- Migration 089: S74.5 D16 — Dispute evidence fingerprint + sent_letter immutability + cooldown CTA
--
-- Per plans/s74.5_categorization_flywheel.md v2 §7.5 + Q-F/Q-I/Q-M LOCK + G2 LOCK.
--
-- WHY THIS MIGRATION EXISTS
--
-- When a user corrects a line item category (S74.5 D5), the audit re-runs and
-- findings change. Draft dispute letters must auto-refresh to reflect new
-- findings; sent letters must stay immutable for legal chain-of-custody but
-- still surface drift to the user with a cooldown-gated follow-up CTA.
--
-- WHAT THIS MIGRATION ADDS (additive to dispute_outcomes)
--
-- evidence_fingerprint TEXT     — sha256 of {findings, line_item_slugs, total_recovery_estimate}
-- sent_letter           JSONB   — immutable snapshot captured on Mark-as-Sent
-- sent_at               TIMESTAMPTZ — when user clicked Mark-as-Sent
-- last_refresh_at       TIMESTAMPTZ — last time current letter was regenerated (debounce)
-- cooldown_until        TIMESTAMPTZ — sent_at + 30 days; cleared on insurer-response logged
--
-- S74 already shipped Mark-as-Sent (PR #66); this mig closes the snapshot-capture
-- gap so the sent_letter content is immutable as a record. Endpoint wiring
-- happens in the s74.5 D16 follow-up TS work (separate PR or same PR).
--
-- BACKOUT — additive columns only; existing reads continue to work; new fields
-- NULL until set.

BEGIN;

ALTER TABLE dispute_outcomes
  ADD COLUMN IF NOT EXISTS evidence_fingerprint TEXT;

ALTER TABLE dispute_outcomes
  ADD COLUMN IF NOT EXISTS sent_letter JSONB;

ALTER TABLE dispute_outcomes
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

ALTER TABLE dispute_outcomes
  ADD COLUMN IF NOT EXISTS last_refresh_at TIMESTAMPTZ;

ALTER TABLE dispute_outcomes
  ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_dispute_outcomes_fingerprint
  ON dispute_outcomes (evidence_fingerprint)
  WHERE evidence_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dispute_outcomes_cooldown
  ON dispute_outcomes (cooldown_until)
  WHERE cooldown_until IS NOT NULL;

COMMENT ON COLUMN dispute_outcomes.evidence_fingerprint IS
  'S74.5 D16 (Session 82). sha256 of {findings, line_item_slugs, total_recovery_estimate} computed at letter-generation time. Drift detection: compute current fingerprint on view fetch; mismatch + draft → regenerate letter + toast; mismatch + sent → preserve sent_letter immutable + show drift banner + follow-up CTA (cooldown-gated per Q-I LOCK).';

COMMENT ON COLUMN dispute_outcomes.sent_letter IS
  'S74.5 D16 (Session 82). Immutable snapshot of letter_content captured when user clicks Mark-as-Sent. Preserves the legal chain-of-custody record even if subsequent category corrections + audit re-runs change findings + regenerate current letter_content. Q-F LOCK: corrections still allowed on claims with sent disputes; sent_letter immutability is the legal safeguard.';

COMMENT ON COLUMN dispute_outcomes.sent_at IS
  'S74.5 D16 (Session 82). Timestamp when user clicked Mark-as-Sent. Drives cooldown_until = sent_at + 30 days per Q-M LOCK.';

COMMENT ON COLUMN dispute_outcomes.last_refresh_at IS
  'S74.5 D16 (Session 82). Debounce: regenerate current letter on view fetch only if fingerprint mismatch AND now() - last_refresh_at > 5 min. Prevents expensive LLM regenerate cost on rapid view refreshes.';

COMMENT ON COLUMN dispute_outcomes.cooldown_until IS
  'S74.5 D16 (Session 82). sent_at + 30 days (Q-M LOCK). Follow-up letter CTA disabled until this passes OR insurer response is logged via outcome status transition. NULL until sent_at is set.';

COMMIT;
