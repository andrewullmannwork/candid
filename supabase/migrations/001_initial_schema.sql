-- Meddit Initial Schema
-- All tables use UUID primary keys and enforce RLS

-- Enable UUID generation
create extension if not exists "pgcrypto";

-- =============================================================================
-- ENUM TYPES
-- =============================================================================

create type consent_type as enum (
  'tos',
  'privacy_policy',
  'health_data_upload',
  'marketplace_data_sharing',
  'aggregate_data_monetization'
);

create type doc_type as enum ('eob', 'itemized_bill');
create type doc_status as enum ('uploaded', 'processing', 'processed', 'error');
create type subscription_status as enum ('none', 'trialing', 'active', 'canceled', 'past_due');
create type subscription_tier as enum ('free', 'pro');
create type ticket_status as enum ('open', 'in_progress', 'resolved', 'closed');

-- =============================================================================
-- USERS
-- =============================================================================

create table users (
  id uuid primary key default gen_random_uuid(),
  firebase_uid text unique not null,
  email text not null,
  display_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table users enable row level security;

-- Users can read their own row
create policy "users_select_own" on users
  for select using (id = auth.uid());

-- Users can update their own display_name/email
create policy "users_update_own" on users
  for update using (id = auth.uid())
  with check (id = auth.uid());

-- Service role inserts via API (no user-facing insert policy)

-- =============================================================================
-- PROFILES
-- =============================================================================

create table profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  insurer text,
  plan_type text,
  state text,
  primary_concern text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id)
);

alter table profiles enable row level security;

create policy "profiles_select_own" on profiles
  for select using (user_id = auth.uid());

create policy "profiles_insert_own" on profiles
  for insert with check (user_id = auth.uid());

create policy "profiles_update_own" on profiles
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- =============================================================================
-- WAITLIST
-- =============================================================================

create table waitlist (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  source text,
  referral_code text,
  created_at timestamptz not null default now()
);

alter table waitlist enable row level security;

-- Waitlist is insert-only from API (service role); admin reads via service role
-- No user-facing RLS policies needed

-- =============================================================================
-- CONSENT EVENTS (IMMUTABLE AUDIT TRAIL)
-- =============================================================================

create table consent_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  email text,
  consent_type consent_type not null,
  consent_version text not null,
  consent_text_hash text not null,
  granted boolean not null,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table consent_events enable row level security;

-- Users can read their own consent history
create policy "consent_select_own" on consent_events
  for select using (user_id = auth.uid());

-- Insert only — no update, no delete (immutable)
create policy "consent_insert_own" on consent_events
  for insert with check (user_id = auth.uid());

-- Block all updates and deletes at the policy level
-- (Even service role should use a separate admin function if needed)
create policy "consent_no_update" on consent_events
  for update using (false);

create policy "consent_no_delete" on consent_events
  for delete using (false);

-- =============================================================================
-- DOCUMENTS
-- =============================================================================

create table documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  file_size bigint not null,
  doc_type doc_type not null,
  consent_event_id uuid not null references consent_events(id),
  status doc_status not null default 'uploaded',
  created_at timestamptz not null default now()
);

alter table documents enable row level security;

create policy "documents_select_own" on documents
  for select using (user_id = auth.uid());

create policy "documents_insert_own" on documents
  for insert with check (user_id = auth.uid());

-- Admin select (for admin dashboard)
create policy "documents_admin_select" on documents
  for select using (
    exists (select 1 from users where users.id = auth.uid() and users.is_admin = true)
  );

-- =============================================================================
-- STRIPE CUSTOMERS
-- =============================================================================

create table stripe_customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique not null references users(id) on delete cascade,
  stripe_customer_id text unique not null,
  subscription_status subscription_status not null default 'none',
  subscription_tier subscription_tier not null default 'free',
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table stripe_customers enable row level security;

create policy "stripe_select_own" on stripe_customers
  for select using (user_id = auth.uid());

-- Updates happen via webhook (service role), not user-facing

-- =============================================================================
-- SUPPORT TICKETS
-- =============================================================================

create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  email text not null,
  subject text not null,
  body text not null,
  status ticket_status not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table support_tickets enable row level security;

create policy "tickets_select_own" on support_tickets
  for select using (user_id = auth.uid());

create policy "tickets_insert_own" on support_tickets
  for insert with check (user_id = auth.uid());

-- Admin select
create policy "tickets_admin_select" on support_tickets
  for select using (
    exists (select 1 from users where users.id = auth.uid() and users.is_admin = true)
  );

-- Admin update (status changes)
create policy "tickets_admin_update" on support_tickets
  for update using (
    exists (select 1 from users where users.id = auth.uid() and users.is_admin = true)
  );

-- =============================================================================
-- INDEXES
-- =============================================================================

create index idx_users_firebase_uid on users(firebase_uid);
create index idx_profiles_user_id on profiles(user_id);
create index idx_documents_user_id on documents(user_id);
create index idx_consent_events_user_id on consent_events(user_id);
create index idx_consent_events_type_version on consent_events(consent_type, consent_version);
create index idx_stripe_customers_stripe_id on stripe_customers(stripe_customer_id);
create index idx_support_tickets_user_id on support_tickets(user_id);
create index idx_support_tickets_status on support_tickets(status);

-- =============================================================================
-- UPDATED_AT TRIGGER
-- =============================================================================

create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_updated_at
  before update on profiles
  for each row execute function update_updated_at();

create trigger stripe_customers_updated_at
  before update on stripe_customers
  for each row execute function update_updated_at();

create trigger support_tickets_updated_at
  before update on support_tickets
  for each row execute function update_updated_at();
