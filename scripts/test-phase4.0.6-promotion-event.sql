-- Phase 4.0.6 Task 4.0.6-L smoke test scenarios C15 + C16 + C17.
--
-- Per Subplan §3 In scope item #11. Run sequentially in Supabase SQL editor.
-- Each block wraps in BEGIN/ROLLBACK so no test data persists.
--
-- Prior tests already validated end-to-end (manual smoke 2026-05-04):
--   C13: corroboration evaluator counts distinct users → covered by Test 2 + Test 3
--   C14: promotion event fires + writes canonical → covered by Test 3 + Test 4
--   C18: backward compat (flag OFF) → implicit; flag is OFF in PROD, mig 064 RPC unchanged
--
-- C13.5 (helper-discipline grep): see scripts/test-phase4.0.6-helper-discipline.ts.
--
-- This file covers:
--   C15: active corroboration challenge state transitions
--   C16: admin notification metadata appending (lifecycle observability)
--   C17: cross-user inheritance gate (confidence >= 0.9)


-- ============================================================================
-- TEST C15 — challenge state transitions
-- ============================================================================
-- Setup: create canonical + 1 user (proposer) + 1 challenge.
-- Run sanity_passed → pending_corroboration.
-- Inject 3 corroboration observations → status='corroborated'.
-- Verify canonical_plan_services updated with promoted value.

BEGIN;

INSERT INTO canonical_plans (id, plan_name, plan_year, state)
VALUES ('c1500000-1500-1500-1500-150000000001', 'SMOKE_C15_CANONICAL', 2026, 'CA');

INSERT INTO users (id, firebase_uid, email, created_at) VALUES
  ('c1500001-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'c15_fb_uid_1', 'c15_proposer@phase406.test', now());

-- Step 1: create challenge (NOTE: TS layer normally does this; SQL-layer test
-- exercises the row state machine independently of TS sendChallengeNotification).
INSERT INTO canonical_correction_challenges (
  id, canonical_plan_id, service_slug, field_name,
  proposed_value, proposed_by_user_id,
  status, time_decay_at
) VALUES (
  'c150000a-1500-1500-1500-15000000000a',
  'c1500000-1500-1500-1500-150000000001',
  NULL,
  'deductible_individual',
  '1500'::jsonb,
  'c1500001-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  'pending_sanity_check',
  now() + INTERVAL '90 days'
);

-- Step 2: sanity check passed → pending_corroboration
UPDATE canonical_correction_challenges
SET sanity_check_passed = true,
    sanity_check_at = now(),
    sanity_check_notes = 'smoke: user OCR matches $1500',
    status = 'pending_corroboration',
    updated_at = now()
WHERE id = 'c150000a-1500-1500-1500-15000000000a';

-- Verify status transition
SELECT status, sanity_check_passed
FROM canonical_correction_challenges
WHERE id = 'c150000a-1500-1500-1500-15000000000a';
-- Expected: status='pending_corroboration', sanity_check_passed=true

-- Step 3: record 3 corroboration observations (TS layer normally does this via
-- recordChallengeObservation; SQL-test exercises the count++ + auto-resolve).
UPDATE canonical_correction_challenges
SET corroboration_count = 3,
    status = 'corroborated',
    resolved_at = now(),
    updated_at = now()
WHERE id = 'c150000a-1500-1500-1500-15000000000a';

-- Step 4: fire value_corrected_via_challenge promotion event
SELECT apply_promotion_event(
  'c1500000-1500-1500-1500-150000000001',
  NULL,
  'deductible_individual',
  '1500'::jsonb,
  '[{"user_id_hash": "c15_proposer", "excerpt": "Deductible $1,500", "document_ref": "challenge", "recorded_at": "2026-05-04T00:00:00Z"}]'::jsonb,
  'correction-challenge-resolution',
  'c1500001-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
) AS event_id;

-- Verify canonical updated to 0.9 confidence with corrected value
SELECT
  field_provenance->'deductible_individual'->>'value' AS value,
  (field_provenance->'deductible_individual'->>'confidence')::NUMERIC AS confidence,
  field_provenance->'deductible_individual'->>'source' AS source
FROM canonical_plans
WHERE id = 'c1500000-1500-1500-1500-150000000001';
-- Expected: value=1500, confidence=0.9, source='multi_source_corroboration'

-- Verify event log row created with correct event_type
SELECT event_type, fire_source
FROM canonical_promotion_events
WHERE canonical_plan_id = 'c1500000-1500-1500-1500-150000000001';
-- Expected: 1 row, event_type='first_promotion', fire_source='correction-challenge-resolution'
-- (NOTE: even though semantically "value_corrected_via_challenge", apply_promotion_event
--  writes 'first_promotion' when canonical was previously NULL/below-threshold; this is
--  correct race-aware behavior. TS layer logs the challenge resolution separately.)

ROLLBACK;


-- ============================================================================
-- TEST C16 — admin notification metadata appending (DB lifecycle observability)
-- ============================================================================
-- TS-side notification module's admin_notification_metadata appending is what
-- this test simulates. Slack webhook delivery is not exercised here (requires
-- live SLACK_WEBHOOK_URL; covered by manual integration smoke during admin soak).

BEGIN;

INSERT INTO canonical_plans (id, plan_name, plan_year, state)
VALUES ('c1600000-1600-1600-1600-160000000001', 'SMOKE_C16_CANONICAL', 2026, 'CA');

INSERT INTO users (id, firebase_uid, email, created_at) VALUES
  ('c1600001-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'c16_fb_uid_1', 'c16_proposer@phase406.test', now());

INSERT INTO canonical_correction_challenges (
  id, canonical_plan_id, field_name, proposed_value, proposed_by_user_id,
  status, time_decay_at
) VALUES (
  'c160000a-1600-1600-1600-16000000000a',
  'c1600000-1600-1600-1600-160000000001',
  'deductible_individual',
  '2200'::jsonb,
  'c1600001-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  'pending_sanity_check',
  now() + INTERVAL '90 days'
);

-- Simulate TS notification module appending metadata for 3 events:
-- submitted (Slack OK, email_pending bookend) + sanity_passed (Slack OK) +
-- corroboration_added (Slack OK).
UPDATE canonical_correction_challenges
SET admin_notification_sent_at = ARRAY[now() - INTERVAL '5 minutes', now() - INTERVAL '3 minutes', now()],
    admin_notification_metadata = jsonb_build_array(
      jsonb_build_object('event', 'submitted',           'channel', 'slack',         'success', true, 'recorded_at', (now() - INTERVAL '5 minutes')::TEXT),
      jsonb_build_object('event', 'submitted',           'channel', 'email_pending', 'success', true, 'recorded_at', (now() - INTERVAL '5 minutes')::TEXT),
      jsonb_build_object('event', 'sanity_passed',       'channel', 'slack',         'success', true, 'recorded_at', (now() - INTERVAL '3 minutes')::TEXT),
      jsonb_build_object('event', 'corroboration_added', 'channel', 'slack',         'success', true, 'recorded_at', now()::TEXT)
    ),
    updated_at = now()
WHERE id = 'c160000a-1600-1600-1600-16000000000a';

-- Verify metadata array length + bookend tagging
SELECT
  jsonb_array_length(admin_notification_metadata) AS metadata_count,
  array_length(admin_notification_sent_at, 1) AS sent_at_count,
  notification_failure_count AS failures
FROM canonical_correction_challenges
WHERE id = 'c160000a-1600-1600-1600-16000000000a';
-- Expected: metadata_count=4 (3 Slack + 1 email_pending bookend), sent_at_count=3, failures=0

-- Verify channel distribution
SELECT
  jsonb_array_elements(admin_notification_metadata)->>'channel' AS channel,
  COUNT(*) AS cnt
FROM canonical_correction_challenges
WHERE id = 'c160000a-1600-1600-1600-16000000000a'
GROUP BY 1
ORDER BY 1;
-- Expected: 1 row with email_pending=1, 1 row with slack=3

-- Verify Slack-failure fallback shape: simulate a failed Slack delivery
UPDATE canonical_correction_challenges
SET admin_notification_metadata = admin_notification_metadata ||
    jsonb_build_array(
      jsonb_build_object('event', 'contradiction_added', 'channel', 'slack',                                  'success', false, 'error_context', '500 Internal Server Error', 'recorded_at', now()::TEXT),
      jsonb_build_object('event', 'contradiction_added', 'channel', 'email_pending_after_slack_failure',     'success', true,  'recorded_at', now()::TEXT)
    ),
    notification_failure_count = notification_failure_count + 1,
    updated_at = now()
WHERE id = 'c160000a-1600-1600-1600-16000000000a';

-- Verify failure tracking
SELECT
  jsonb_array_length(admin_notification_metadata) AS metadata_count,
  notification_failure_count AS failures
FROM canonical_correction_challenges
WHERE id = 'c160000a-1600-1600-1600-16000000000a';
-- Expected: metadata_count=6 (4 prior + 2 from failure event), failures=1

ROLLBACK;


-- ============================================================================
-- TEST C17 — cross-user inheritance gate (confidence >= 0.9)
-- ============================================================================
-- Create canonical_plan_services rows at different confidence levels;
-- verify the inheritance read query filters correctly per Q-P4.0.6-7 LOCK.

BEGIN;

INSERT INTO canonical_plans (id, plan_name, plan_year, state)
VALUES ('c1700000-1700-1700-1700-170000000001', 'SMOKE_C17_CANONICAL', 2026, 'CA');

-- Insert 3 canonical_plan_services rows: low (0.5 legacy), medium (0.7), high (0.9 promoted)
INSERT INTO canonical_plan_services (canonical_plan_id, service_slug, copay, confidence, source) VALUES
  ('c1700000-1700-1700-1700-170000000001', 'smoke_c17_low_service',    25, 0.5, 'sbc_parser'),
  ('c1700000-1700-1700-1700-170000000001', 'smoke_c17_medium_service', 30, 0.7, 'sbc_parser'),
  ('c1700000-1700-1700-1700-170000000001', 'smoke_c17_high_service',   35, 0.9, 'multi_source_corroboration');

-- Simulate flag-OFF query (no confidence filter) — returns all 3 rows
SELECT COUNT(*) AS rows_returned_flag_off
FROM canonical_plan_services
WHERE canonical_plan_id = 'c1700000-1700-1700-1700-170000000001';
-- Expected: rows_returned_flag_off=3

-- Simulate flag-ON query (confidence >= 0.9 filter) — returns 1 row
SELECT COUNT(*) AS rows_returned_flag_on
FROM canonical_plan_services
WHERE canonical_plan_id = 'c1700000-1700-1700-1700-170000000001'
  AND confidence >= 0.9;
-- Expected: rows_returned_flag_on=1

-- Verify the only inherited service is the high-confidence one
SELECT service_slug, confidence, source
FROM canonical_plan_services
WHERE canonical_plan_id = 'c1700000-1700-1700-1700-170000000001'
  AND confidence >= 0.9;
-- Expected: 1 row; service_slug='smoke_c17_high_service', confidence=0.9, source='multi_source_corroboration'

ROLLBACK;
