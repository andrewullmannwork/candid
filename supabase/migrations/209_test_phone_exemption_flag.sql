-- =============================================================================
-- MIGRATION 209 — Test-phone exemption kill switch (S288)
-- =============================================================================
--
-- Seeds the feature_flags KV row backing the /admin/settings → Testing toggle
-- for the test-phone exemption: EXACTLY ONE hardcoded number (Andrew's test
-- number; the constant lives in src/lib/auth/test-phone-exempt.ts as
-- TEST_PHONE_EXEMPT_E164) may exist on multiple accounts simultaneously, so
-- multi-account E2E testing (fresh signups; ≥3-verified-user corroboration)
-- works without burning real phone numbers.
--
-- The number itself is NOT in the database — it is a code constant. This row
-- only turns the exemption on/off (instant: /api/admin/flags PATCH clears the
-- in-memory flag cache; no deploy). OFF → the number behaves like any other
-- (Firebase OTP link, one account per phone) and already-stamped accounts
-- downgrade to phone_verified=false on their next sync.
--
-- Seeded ON (Andrew, S288) so the final-E2E window works immediately at
-- promote. Toggle OFF in /admin/settings after the E2E if desired.
--
-- ROLLBACK:
--   UPDATE feature_flags SET value = 'false'
--   WHERE key = 'TEST_PHONE_EXEMPTION_ENABLED';
-- =============================================================================

INSERT INTO feature_flags (key, value, description)
VALUES (
  'TEST_PHONE_EXEMPTION_ENABLED',
  'true',
  'Test phone exemption: allow the ONE hardcoded test number (+1 904-294-1389; constant in src/lib/auth/test-phone-exempt.ts) on multiple accounts — signup skips the Firebase OTP link and /api/auth/sync stamps the number as verified. OFF = that number behaves like any other (strict one-account-per-phone; stamped accounts downgrade on next sync). Toggle in /admin/settings → Testing.'
)
ON CONFLICT (key) DO NOTHING;
