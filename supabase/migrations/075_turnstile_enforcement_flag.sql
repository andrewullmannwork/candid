-- =============================================================================
-- MIGRATION 075 — Turnstile enforcement feature flag (S68)
-- =============================================================================
--
-- Seeds the `turnstile_enforcement_v1` row in `feature_flag_rules` so the
-- server-side verification gate at /api/auth/sync, /api/auth/reset-password,
-- and /api/documents/upload can be flipped global ON post-deploy without a
-- code change. Default OFF so the PR can merge to main, deploy, and verify
-- the widget renders + token is captured before enforcement begins.
--
-- WHY:
--   S67 closed the waitlist gate; signup is now public-open. Without bot
--   defense, a single attacker can trivially create thousands of disposable
--   accounts to consume OCR / Haiku budget, pollute the data flywheel, or
--   abuse password reset for email enumeration. Turnstile is the
--   minimum-viable bot defense per [[plans/mvp_friday_master]] §S68 (Pillar
--   P4 — Required-Ops carve-out) and complements the email-verified gate
--   (mig 074) + S69 phone OTP 2FA (forthcoming) for layered identity defense
--   per Pattern 1 #15.
--
-- ROLLOUT PLAN:
--   1. Merge this migration with default OFF.
--   2. Deploy code (widget + server verify) — at this stage flag OFF means
--      widget renders for all users and server skips verification (no enforcement).
--   3. User-tests widget flow end-to-end; confirms no UX breakage.
--   4. Flip flag global ON: UPDATE feature_flag_rules SET enabled=true
--      WHERE flag_key='turnstile_enforcement_v1'. Server starts 403'ing
--      requests without valid tokens.
--   5. Monitor Vercel logs for 403 spike (legitimate users blocked) — if
--      spike >5%, flip OFF and investigate (likely ad-blocker scenario).
--
-- ROLLBACK:
--   Flip flag OFF — server reverts to no-op. The widget still renders and
--   captures tokens client-side but tokens go unverified server-side.
--   Removal of the row is forbidden per Pattern 1 #10 hard-delete prohibition.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'turnstile_enforcement_v1',
  false,
  'S68 (Session 68). Cloudflare Turnstile bot defense on /api/auth/sync (signup + signin user-action paths only — passive resyncs from onAuthStateChanged are NOT gated), /api/auth/reset-password, and /api/documents/upload. When OFF, server skips verification and accepts any (or no) token. When ON, server requires a valid Turnstile token via the Cloudflare siteverify API (https://challenges.cloudflare.com/turnstile/v0/siteverify) and returns 403 on missing/invalid. Widget mode: Managed (Cloudflare auto-tunes invisible vs interactive). Flip global ON post-deploy after verifying widget + token capture in PROD per S68 rollout plan.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
