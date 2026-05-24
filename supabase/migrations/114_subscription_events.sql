-- Migration 114: subscription_events table for /billing flywheel signals
--
-- Adds a lightweight event log scoped per-user for cancel-reason capture
-- and future subscription-related telemetry (downgrade reasons, churn
-- surveys, etc.). Service-role writes only (Firebase auth — no Supabase
-- auth.uid() mapping). RLS denies anon/authenticated; reads via server
-- endpoints with the service role client.

create table subscription_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index idx_subscription_events_user_id on subscription_events(user_id);
create index idx_subscription_events_type on subscription_events(event_type);

alter table subscription_events enable row level security;

-- No client policies = RLS denies anon/authenticated by default.
-- All reads + writes route through server endpoints with the service role.

comment on table subscription_events is
  'User-scoped subscription event log (cancel reasons, downgrade reasons, churn telemetry).
   Writes via service role only; no client policies. Pattern 1 #14 (user-scoped storage).';

comment on column subscription_events.event_type is
  'Event identifier. Known values: cancel_reason_captured. New values added as flywheel signals expand.';

comment on column subscription_events.metadata is
  'Event payload (JSONB). For cancel_reason_captured: { reason: string, note?: string }.';
