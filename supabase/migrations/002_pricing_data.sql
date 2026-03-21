-- Candid Care — Pricing data aggregation table
-- Stores anonymized pricing data points from user-submitted bills and public sources.
-- Powers the Candid Care price transparency tool once data volume is sufficient.

create type pricing_data_source as enum ('user_bill', 'cms_mrf', 'hospital_hpt', 'cms_ppl');

create table pricing_data (
  id uuid primary key default gen_random_uuid(),
  procedure_code text not null,         -- CPT/HCPCS code
  procedure_category text,              -- Plain-English category
  facility_name text,                   -- Provider/facility name (from bill or public data)
  facility_npi text,                    -- NPI if available
  region text not null,                 -- State or metro area
  billed_amount numeric(12,2),          -- What provider charged
  allowed_amount numeric(12,2),         -- What insurance allows
  insurance_paid numeric(12,2),         -- What insurance paid
  patient_paid numeric(12,2),           -- What patient paid
  data_source pricing_data_source not null,
  confidence_score numeric(3,2) not null default 0.50,  -- 0.00-1.00
  source_document_id uuid references documents(id) on delete set null,  -- NULL for public data
  service_date date,                    -- When service was rendered
  created_at timestamptz not null default now()
);

alter table pricing_data enable row level security;

-- No user-facing read access — all queries go through service role API
-- This ensures data is always returned as aggregates, never individual records
create policy "pricing_data_no_user_select" on pricing_data
  for select using (false);

create policy "pricing_data_no_user_insert" on pricing_data
  for insert with check (false);

-- Indexes for common query patterns
create index idx_pricing_code_region on pricing_data(procedure_code, region);
create index idx_pricing_facility on pricing_data(facility_npi) where facility_npi is not null;
create index idx_pricing_source on pricing_data(data_source);
create index idx_pricing_created on pricing_data(created_at);

-- Materialized view for fast aggregate lookups
-- Refresh periodically (daily cron or after batch inserts)
create materialized view pricing_aggregates as
select
  procedure_code,
  procedure_category,
  region,
  facility_name,
  facility_npi,
  count(*) as data_points,
  round(avg(billed_amount)::numeric, 2) as avg_billed,
  round(percentile_cont(0.5) within group (order by billed_amount)::numeric, 2) as median_billed,
  round(min(billed_amount)::numeric, 2) as min_billed,
  round(max(billed_amount)::numeric, 2) as max_billed,
  round(avg(allowed_amount)::numeric, 2) as avg_allowed,
  round(avg(patient_paid)::numeric, 2) as avg_patient_paid,
  -- Confidence: higher when more user-verified data points exist
  round(
    (count(*) filter (where data_source = 'user_bill')::numeric / greatest(count(*), 1)) * 0.5
    + least(count(*)::numeric / 10, 0.5),  -- More data points = higher confidence, capped at 0.5
  2) as aggregate_confidence,
  max(created_at) as last_updated
from pricing_data
where billed_amount is not null
group by procedure_code, procedure_category, region, facility_name, facility_npi;

create unique index idx_pricing_agg_lookup
  on pricing_aggregates(procedure_code, region, facility_npi);
