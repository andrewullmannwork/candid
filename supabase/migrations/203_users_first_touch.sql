-- =============================================================================
-- MIGRATION 203 — users.first_touch: channel attribution (GTM measurement P3)
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
--
--   Growth measurement (GTM playbook 04) attributes the one metric — documents
--   uploaded — to the channel that first brought the user in. The client
--   captures a first-touch snapshot (UTM params / external referrer host) in
--   localStorage on the user's FIRST landing, and /api/auth/sync persists it
--   onto the users row at signup. No client-side analytics tool is involved
--   (S199 rule: no third-party trackers; this is first-party only — the blob
--   travels exactly once, browser → our API → this column).
--
-- WHAT THIS MIGRATION ADDS
--
--   users.first_touch JSONB NULL — shape (all optional):
--     { "source":        utm_source   (e.g. "reddit", "creator-popcorn"),
--       "medium":        utm_medium   (e.g. "community", "referral"),
--       "campaign":      utm_campaign (e.g. "denial-code-wave-1"),
--       "referrer_host": external referrer hostname (e.g. "chatgpt.com"),
--       "landing":       first landing pathname,
--       "ts":            ISO timestamp of first touch }
--
--   Written ONLY on the new-user INSERT in /api/auth/sync (first-touch wins;
--   resyncs and account-links never overwrite). NULL = pre-attribution user
--   or direct/unknown arrival. Sanitized server-side (allowlisted keys,
--   length-capped strings). No index — analytical reads only, at current
--   scale a seq scan is fine; add GIN later if attribution queries slow.
--
-- BACKOUT — additive column (Rule 7); ignore it or, if truly needed,
--   UPDATE users SET first_touch = NULL. Do not DROP (Rule 7).

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS first_touch JSONB;

COMMENT ON COLUMN users.first_touch IS
  'GTM channel attribution (mig 203, 2026-07). First-touch UTM/referrer snapshot persisted once at signup by /api/auth/sync; never overwritten. Keys: source, medium, campaign, referrer_host, landing, ts. NULL = pre-attribution or direct arrival. See GTM playbook 04.';

COMMIT;
