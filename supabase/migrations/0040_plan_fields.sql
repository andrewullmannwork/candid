-- Migration 004: Extended plan identification fields on profiles
-- Adds specific plan details needed to accurately identify benefits and audit results

alter table profiles
  add column if not exists plan_name text,
  add column if not exists group_number text,
  add column if not exists member_id text,
  add column if not exists deductible_individual numeric,
  add column if not exists oop_max_individual numeric,
  add column if not exists copay_primary numeric,
  add column if not exists copay_specialist numeric,
  add column if not exists copay_er numeric,
  add column if not exists coinsurance_pct numeric,
  add column if not exists insurance_card_path text;
