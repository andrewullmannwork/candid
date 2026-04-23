-- Migration 046: Stripe webhook event deduplication
--
-- Stripe retries webhooks on network hiccups; without dedup, a single event
-- can fire customer.subscription.updated 2-3 times and corrupt
-- cancel_at_period_end / status state. This table is the idempotency key:
-- the webhook handler inserts (event_id) before processing; ON CONFLICT
-- means "already seen, skip."

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_events_received_at
  ON stripe_events(received_at DESC);
