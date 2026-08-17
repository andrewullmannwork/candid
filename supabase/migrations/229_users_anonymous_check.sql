-- 229 — S315 A-1: anonymous bill-check entry (no-account funnel foundation).
-- Design record: vault plans/s315-anonymous-funnel-design.md §7.1 (Firebase
-- anonymous provider → standard users row; upgrade = linkWithCredential, uid
-- unchanged). Additive only (Rule #7).
--
-- is_anonymous: TRUE while the row's Firebase account is the anonymous
--   provider; the upgrade sync flips it false. Corroboration exclusion does
--   NOT read this flag — it already rides phone_verified=false (S69 gate),
--   which an anonymous account cannot satisfy until the upgrade's OTP.
-- contact_email: the typed results/deletion contact for anonymous checks
--   (MHMDA delivery + deletion channel). NEVER identity: no uniqueness, and
--   account-link continues to key exclusively on the Firebase TOKEN email —
--   users.email for anonymous rows holds a synthetic per-uid placeholder so a
--   typed third-party address can never collide with or link to a real
--   account. Cleared by the sync when the upgrade stamps the real email.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_email text;

COMMENT ON COLUMN users.is_anonymous IS
  'S315 A-1: Firebase anonymous-provider account (no-account bill check). Flipped false by the linkWithCredential upgrade sync. Corroboration exclusion rides phone_verified=false, not this flag.';
COMMENT ON COLUMN users.contact_email IS
  'S315 A-1: typed results/deletion contact for anonymous checks. Never identity — no uniqueness; account-link keys on the Firebase token email only. Cleared on upgrade.';

-- Retention sweeps (design §8 decision 7) scan anonymous rows by age.
CREATE INDEX IF NOT EXISTS idx_users_anonymous_created
  ON users (created_at)
  WHERE is_anonymous;

-- Rollback (documented, not executed): additive columns + partial index;
--   DROP INDEX idx_users_anonymous_created; ALTER TABLE users DROP COLUMN contact_email; ALTER TABLE users DROP COLUMN is_anonymous;
