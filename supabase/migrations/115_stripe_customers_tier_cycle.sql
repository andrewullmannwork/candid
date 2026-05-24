-- Migration 115: stripe_customers.tier_cycle for annual plan support
--
-- Adds billing cycle column to support B2.2 annual plan tier (Phase 2 §B2.2
-- decision D-§1.B.4-B). Defaults to 'monthly' to preserve existing state.
-- Switch happens via /api/stripe/change-subscription endpoint (handles
-- proration via Stripe subscription update). Synced from Stripe webhook on
-- customer.subscription.created/updated events by inspecting the price id.

alter table stripe_customers
  add column if not exists tier_cycle text not null default 'monthly'
    check (tier_cycle in ('monthly', 'annual'));

comment on column stripe_customers.tier_cycle is
  'Subscription billing cycle. monthly = STRIPE_PRO_PRICE_ID ($5/mo).
   annual = STRIPE_PRO_ANNUAL_PRICE_ID ($48/yr; 16.7% off monthly).
   Synced from Stripe webhook on subscription events. Free-tier rows keep default ''monthly''.';
