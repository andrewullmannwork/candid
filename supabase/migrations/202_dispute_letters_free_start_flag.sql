-- =============================================================================
-- MIGRATION 202 — Dispute letters "free to start" FE alignment: rollout gate
-- =============================================================================
--
-- Seeds the single feature_flag_rules row that gates the dispute-letters
-- "free to start, pay to escalate" front-end alignment (mixed FE+BE workstream;
-- plans/dispute-letters-free-to-start-alignment.md). Mirrors the mig 139
-- flag-seed shape (target_type + config JSONB; flag_key sole UNIQUE).
--
-- (Mig number 201 — assigned by Andrew; 200 is admin_audit_log, #232.
--  See plans/workstream_coordination.md "Claimed migration numbers".)
--
-- WHY THIS MIGRATION EXISTS
--
--   The BACKEND is already "free to start": /api/disputes/generate (Case 1) and
--   escalate-gate only require Pro for the escalation letters (final_notice /
--   external_review); first-contact letters + debt_validation are free. But the
--   FRONTEND still walls the whole /disputes page for any non-Pro user, and the
--   landing + billing copy frame letters as a Pro feature. This flag gates the
--   FE alignment (remove the /disputes Pro-wall for authed users + "your letters
--   are free" copy on landing/billing) so it's a single reversible switch.
--
-- WHAT THIS MIGRATION ADDS
--
--   feature_flag_rules:
--     dispute_letters_free_start_v1  enabled=false  target_type=global  config={}
--
-- BEHAVIOR
--
--   OFF (default): today's behavior, byte-identical — /disputes shows the
--     LockedOverlay ("Dispute Letters requires Candid Pro") to non-Pro users;
--     landing + billing keep the Pro-framed copy. Graceful degradation: the
--     three client surfaces read this flag via GET /api/feature-flags/
--     dispute_letters_free_start_v1 (whitelisted in EXPOSED_FLAGS) and fall back
--     to OFF when the row is absent or the read fails (no crash) — safe to ship
--     before this row exists.
--   ON: /disputes renders the workspace for all authed users (free users draft +
--     download first-contact letters, which the backend already allows;
--     escalation CTAs 403 → "Escalation letters are a Candid Pro feature — your
--     dispute letters are always free" toast); landing + billing show the
--     free-to-start copy. No backend access change — the routes are unchanged.
--   Emergency revert:
--     UPDATE feature_flag_rules SET enabled = false
--       WHERE flag_key = 'dispute_letters_free_start_v1';
--
--   CONFIG JSONB — intentionally empty ({}). A future per-count free cap (a
--   paywall after N free disputes) will populate it (e.g. {"freeQuota": N}),
--   read by evaluateLetterAccess in src/lib/disputes/letter-access.ts with a
--   per-field fallback to code defaults, so an empty config is always safe.
--
-- BACKOUT — flag row only; DELETE the row to remove. With the flag absent,
-- isFeatureEnabled returns false and the browser reads resolve to OFF → today's
-- Pro-walled behavior (status quo). Safe.

BEGIN;

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'dispute_letters_free_start_v1',
  false,
  'Dispute letters "free to start, pay to escalate" FE alignment (2026-07). Default OFF. Gates: /disputes Pro-wall removal for authed users (free users draft/download first-contact letters — backend already permits; only final_notice/external_review need Pro) + landing/billing "your dispute letters are free" copy. OFF preserves today''s LockedOverlay + Pro-framed copy byte-identical (graceful degradation: three client surfaces read this via /api/feature-flags and fall back to OFF when absent). config JSONB empty; a future per-count free cap populates {freeQuota} read by evaluateLetterAccess. See plans/dispute-letters-free-to-start-alignment.md.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
