-- =============================================================================
-- MIGRATION 119 — File hash blocklist (Ing-G.4, pre-launch backend hardening)
-- =============================================================================
--
-- Adds an admin-curated blocklist of file_hash values that should be rejected
-- at upload time before any storage write, classifier call, or Haiku spend.
--
-- WHY THIS MIGRATION EXISTS
--
-- Per `plans/pre_launch_backend_hardening.md` block Ing-G.4: defense-in-depth
-- kill-switch for adversarial uploads. Today the upload pipeline has dedup
-- (file_hash UNIQUE per user) and rate limits (3x same hash per user), but no
-- admin mechanism to *permanently* block a known-bad hash across all users.
-- This migration adds that surface so admins can stop a known adversarial PDF
-- (synthetic SBC, poisoning attempt, etc.) the moment it's identified —
-- without a code deploy.
--
-- Ships pre-launch with the table empty; populated as incidents surface.
-- Long-term placeholder: hash-share with peer platforms (Phase 2+, not in
-- scope for this migration).
--
-- WHAT THIS MIGRATION ADDS
--
-- 1. file_hash_blocklist table — (file_hash PK, reason, added_by_admin_id,
--    added_at, notes). PK on file_hash gives O(1) lookup at upload time.
--    Forensic columns (added_by, added_at, notes) per Pattern 1 #10 audit trail.
-- 2. file_hash_blocklist_enabled feature flag — seeded ON, global. Lets
--    operators flip the gate OFF at the DB layer without a code deploy if
--    the check itself ever misbehaves. Empty blocklist + flag ON = no-op,
--    so the default-ON ships safe.
--
-- BLOCK SEMANTICS — FORWARD-ONLY (decision locked at S125)
--
-- Adding a hash to the blocklist ONLY rejects NEW uploads. Existing
-- `documents` rows with the matching hash are NOT retroactively flipped to
-- `status='rejected'`. Cleaner semantics (no surprise to the affected user)
-- and matches the plan's "cheap rejection at upload time" wording.
-- Downstream canonical cleanup (if a contaminated doc reached canonical
-- promotion) is a separate operation outside this block's scope.
--
-- ADMIN AUTH MODEL
--
-- Server-only table: no RLS policies, reads/writes go through service_role
-- from /api/admin/documents/blocklist (admin-only endpoint) and the upload
-- route. Mirrors the pattern used by other admin-controlled curation tables
-- in the codebase. Admin status enforced at the API layer via
-- users.is_admin (same gate as /api/admin/documents/signed-url).
--
-- BACKOUT — additive only. New table can be dropped; existing tables
-- untouched. Feature flag row can be deleted if rolling back.

BEGIN;

-- ============================================================================
-- SECTION 1: file_hash_blocklist table
-- ============================================================================

CREATE TABLE IF NOT EXISTS file_hash_blocklist (
  file_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  added_by_admin_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_file_hash_blocklist_added_at
  ON file_hash_blocklist (added_at DESC);

COMMENT ON TABLE file_hash_blocklist IS
  'Ing-G.4 (S125). Admin-curated blocklist of file_hash values rejected at upload time before storage write, classifier call, or Haiku spend. Forward-only semantics: adding a hash blocks NEW uploads only; existing documents rows with matching hash are NOT retroactively flipped. Populated by /api/admin/documents/blocklist; consulted by /api/documents/upload via src/lib/security/file-hash-blocklist.ts. Read by service_role only; no RLS policies. Admin status enforced at the API layer.';

COMMENT ON COLUMN file_hash_blocklist.file_hash IS
  'SHA-256 hex (64 chars) — matches documents.file_hash shape from mig 090. PK gives O(1) lookup at upload time.';

COMMENT ON COLUMN file_hash_blocklist.reason IS
  'Admin-supplied free-text reason (e.g., "synthetic SBC — sample 42 from adversarial corpus", "incident #2026-005 poisoning attempt"). Required to enforce an audit trail.';

COMMENT ON COLUMN file_hash_blocklist.added_by_admin_id IS
  'FK to users(id) of the admin who added the row. ON DELETE RESTRICT prevents admin row deletion while blocklist refs exist (Pattern 1 #10 forensic trail).';

COMMENT ON COLUMN file_hash_blocklist.added_at IS
  'Timestamp the hash was added. DEFAULT now() so adds via direct INSERT also get a timestamp.';

COMMENT ON COLUMN file_hash_blocklist.notes IS
  'Optional context — Slack permalink, incident ticket ID, secondary admin who reviewed, etc.';

-- ============================================================================
-- SECTION 2: file_hash_blocklist_enabled feature flag
-- ============================================================================
-- Seeded ON, global. Empty blocklist + flag ON = no-op (zero regression at
-- ship). Operators flip OFF only if the gate itself misbehaves; emergency
-- revert path without redeploy.

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'file_hash_blocklist_enabled',
  true,
  'Ing-G.4 (S125). Gates the upload-time blocklist check in /api/documents/upload. ON = check file_hash_blocklist before storage write + classifier call. OFF = skip the check (no-op revert path). Default ON; empty blocklist makes ON a no-op so default ships safe.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
