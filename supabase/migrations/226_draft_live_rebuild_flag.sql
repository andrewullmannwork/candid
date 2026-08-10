-- =============================================================================
-- MIGRATION 226 — Draft live rebuild feature flag (S306, tracker AF / UX-2)
-- =============================================================================
--
-- Seeds `dispute_draft_live_rebuild_v1` in `feature_flag_rules`. Gates the
-- "a draft letter is a live document; a sent letter is a record" behavior
-- (Andrew, S306).
--
-- WHY IT EXISTS. W4 made letters persistent and never background-updated: the
-- letter GET serves the saved body, and a drifted draft shows the "plan
-- details changed" banner whose Refresh is the ONLY rebuild path. Andrew's
-- ruling supersedes that for drafts: a draft that does not match current
-- inputs is not viable to send, so it is a bug, not a feature. Sent letters
-- stay immutable and keep the banner — informing is all we can honestly do
-- there.
--
-- WHAT THE FLAG TURNS ON.
--   1. The letter GET honors the decision function's existing
--      `regenerate_draft` branch: an unsent letter regenerates on view
--      whenever its fingerprint drifts — no banner, no explicit refresh —
--      with the 5-minute debounce zeroed (a live draft never serves a
--      just-changed address as stale).
--   2. The evidence fingerprint gains a COMPOSE section for unsent letters
--      only (attested name, provider name/address, insurer-address override,
--      collector, account number) — the inputs the letter is a function of
--      that the evidence hash was blind to. Change only the provider address
--      and it now drifts. SHAPE RULE: sent letters stay evidence-only
--      (mark-as-sent stamps without compose), so this extension can never
--      false-flag a sent letter's drift banner — and it makes the first view
--      after an UNSEND a guaranteed mismatch, so the letter rebuilds to
--      current inputs immediately.
--
-- OFF = byte-identical: the loader attaches no compose basis, the GET keeps
-- W4's refresh-only rule, and `isFeatureEnabled` on a missing row is false —
-- the shipped code is inert until this row exists.
--
-- ROLLBACK: flip OFF (UPDATE feature_flag_rules SET enabled=false WHERE
-- flag_key='dispute_draft_live_rebuild_v1'). Stored fingerprints stamped with
-- the compose shape self-heal: the next drift regenerates and restamps with
-- the flag-off shape. No data migration to unwind.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'dispute_draft_live_rebuild_v1',
  false,
  'S306 (2026-08-05). Draft live rebuild — a draft letter is a live document; a sent letter is a record. ON: an unsent letter regenerates on view whenever its fingerprint drifts (no banner, no explicit refresh, debounce zeroed), and the fingerprint gains a compose section for unsent letters (attested name, provider name/address, insurer-address override, collector, account number) so an edit that changes only those still rebuilds the draft. Sent letters stay immutable, keep the evidence-only fingerprint and the drift banner; mark-as-sent''s evidence-only stamp makes the first post-unsend view a guaranteed rebuild. OFF = byte-identical W4 behavior (serve cached + banner + explicit refresh).',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

-- Verify:
-- SELECT flag_key, enabled, target_type, config FROM feature_flag_rules WHERE flag_key = 'dispute_draft_live_rebuild_v1';
-- Expect: 1 row, enabled = false, target_type = 'global', config = {}.
