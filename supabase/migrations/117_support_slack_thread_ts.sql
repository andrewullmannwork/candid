-- =============================================================================
-- MIGRATION 117 — Support Slack thread linkage (S123 — B2.3 Slack Tier 2)
-- =============================================================================
--
-- Adds slack_thread_ts column to support_tickets to enable bidirectional
-- Slack ↔ email threading. When a new ticket is created, the API posts to
-- the #support Slack channel via chat.postMessage and stores the returned
-- message timestamp here. When an admin replies in the Slack thread, the
-- Events API webhook (/api/slack/events) looks up the ticket by
-- slack_thread_ts and emails the reply to the original submitter via Resend.
--
-- WHY:
--   B2.3 outbound (Tier 1) is satisfied by chat.postMessage alone, but to
--   route admin replies BACK to the user (Tier 2), we need a persistent map
--   from Slack thread → support ticket. Slack's `ts` field is the natural
--   join key — it's the millisecond timestamp of the parent message.
--
-- INDEX RATIONALE:
--   Partial UNIQUE index (WHERE NOT NULL) — each Slack thread maps to exactly
--   one ticket; NULL allowed for tickets that pre-date B2.3 or fail to post
--   to Slack (best-effort outbound; not a hard dependency).
--
-- ROLLBACK:
--   Column is additive. Removal forbidden per Pattern 1 #10. To disable
--   inbound thread-reply routing: unset SLACK_BOT_TOKEN env var (server-side
--   will skip both outbound + inbound, leaving the column unused).
-- =============================================================================

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS slack_thread_ts TEXT;

COMMENT ON COLUMN support_tickets.slack_thread_ts IS
  'B2.3 (Session 123) — Slack message ts of the parent thread for this ticket. Used by /api/slack/events to route admin thread replies back to the original submitter via Resend email. NULL when Slack outbound failed or env not configured.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_slack_thread_ts
  ON support_tickets(slack_thread_ts)
  WHERE slack_thread_ts IS NOT NULL;
