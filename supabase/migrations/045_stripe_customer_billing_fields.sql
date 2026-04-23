-- Migration 045: Stripe customer billing denormalization
--
-- Phase 0 of the Modern Embedded Subscription Billing flow. Additive only —
-- no data migration, no breaking changes. Adds:
--   1. Payment method denorm columns so /billing renders card summary without
--      a round-trip to Stripe on every page load.
--   2. Cancellation state columns so the UI can show "Cancels on <date>"
--      distinct from immediate cancellation.
--   3. Feature flag `embedded_subscribe` (disabled globally by default) — gates
--      the new in-app flow; rollback = flip the flag off.

ALTER TABLE stripe_customers
  ADD COLUMN IF NOT EXISTS default_payment_method_id TEXT;

ALTER TABLE stripe_customers
  ADD COLUMN IF NOT EXISTS card_brand TEXT;

ALTER TABLE stripe_customers
  ADD COLUMN IF NOT EXISTS card_last4 TEXT;

ALTER TABLE stripe_customers
  ADD COLUMN IF NOT EXISTS card_exp_month INTEGER;

ALTER TABLE stripe_customers
  ADD COLUMN IF NOT EXISTS card_exp_year INTEGER;

ALTER TABLE stripe_customers
  ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE stripe_customers
  ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;

ALTER TABLE stripe_customers
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

CREATE INDEX IF NOT EXISTS idx_stripe_customers_subscription_id
  ON stripe_customers(stripe_subscription_id);

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type) VALUES
  ('embedded_subscribe', false, 'In-app embedded Stripe Elements subscribe flow (replaces Stripe Checkout redirect)', 'global')
ON CONFLICT (flag_key) DO NOTHING;
