#!/usr/bin/env bash
# Cost-share v2 (S213) — ephemeral-PG fixture for mig 174.
# Spins an EPHEMERAL local Postgres, models the PROD-relevant referenced objects
# (incl. service_role role + feature_flag_rules WITH config jsonb), applies the
# REAL mig 174, and asserts: column/table/flag effect, both network CHECKs,
# the override NOT-NULL key, FK cascade, idempotency (re-run), and rollback.
# Non-mutating to PROD. Requires local Postgres tools (initdb/pg_ctl/psql). Run:
#   bash scripts/calibration/fixtures/cost-share-v2/run.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
MIG="$REPO/supabase/migrations/174_cost_share_v2_schema.sql"
PGDATA="${TMPDIR:-/tmp}/pg_mig174_fixture"; PORT="${PG_FIXTURE_PORT:-54417}"; LOG="${TMPDIR:-/tmp}/pg_mig174_fixture.log"
[ -f "$MIG" ] || { echo "FAIL: missing $MIG"; exit 1; }
pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
rm -rf "$PGDATA"
trap 'pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true' EXIT
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null 2>&1
pg_ctl -D "$PGDATA" -o "-k ${TMPDIR:-/tmp} -p $PORT -c listen_addresses=''" -l "$LOG" start >/dev/null 2>&1
sleep 1
P(){ psql -h "${TMPDIR:-/tmp}" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

P -c "
CREATE ROLE service_role;
CREATE TABLE public.users (id uuid primary key default gen_random_uuid());
CREATE TABLE public.insurance_plans (id uuid primary key default gen_random_uuid());
CREATE TABLE public.claims (id uuid primary key default gen_random_uuid());
CREATE TABLE public.claim_line_items (id uuid primary key default gen_random_uuid(), claim_id uuid references public.claims(id));
CREATE TABLE public.feature_flag_rules (
  id uuid primary key default gen_random_uuid(), flag_key text not null unique,
  enabled boolean not null default false, description text,
  target_type text not null default 'global', target_users text[] default '{}',
  target_percentage int default 100, config jsonb default '{}'::jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
"
P -f "$MIG"
P -v ON_ERROR_STOP=1 -c "DO \$\$
DECLARE cli int; clm int; u uuid; p uuid; n int;
BEGIN
  SELECT count(*) INTO cli FROM information_schema.columns WHERE table_name='claim_line_items'
    AND column_name IN ('member_applied_to_deductible','member_coinsurance','member_copay','denied_amount','network_status');
  IF cli<>5 THEN RAISE EXCEPTION 'cli cols=% expected 5',cli; END IF;
  SELECT count(*) INTO clm FROM information_schema.columns WHERE table_name='claims'
    AND column_name IN ('network_status','user_network_override');
  IF clm<>2 THEN RAISE EXCEPTION 'claims cols=% expected 2',clm; END IF;
  IF to_regclass('public.claim_accumulators') IS NULL THEN RAISE EXCEPTION 'claim_accumulators missing'; END IF;
  IF to_regclass('public.user_plan_cost_share_overrides') IS NULL THEN RAISE EXCEPTION 'overrides missing'; END IF;
  IF (SELECT enabled FROM feature_flag_rules WHERE flag_key='recovery_cost_share_v2') IS DISTINCT FROM false
    THEN RAISE EXCEPTION 'flag not seeded OFF'; END IF;
  BEGIN INSERT INTO public.claims(id,network_status) VALUES (gen_random_uuid(),'bogus'); RAISE EXCEPTION 'ns check missed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO public.claims(id,user_network_override) VALUES (gen_random_uuid(),'tiered'); RAISE EXCEPTION 'uno check missed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO public.insurance_plans DEFAULT VALUES RETURNING id INTO p;
  INSERT INTO public.users DEFAULT VALUES RETURNING id INTO u;
  BEGIN INSERT INTO public.user_plan_cost_share_overrides(user_id,deductible_met) VALUES (u,true); RAISE EXCEPTION 'notnull key missed';
  EXCEPTION WHEN not_null_violation THEN NULL; END;
  INSERT INTO public.user_plan_cost_share_overrides(user_id,insurance_plan_id,plan_year,deductible_met,deductible_met_as_of) VALUES (u,p,2024,true,'2024-06-01');
  DELETE FROM public.users WHERE id=u;
  SELECT count(*) INTO n FROM public.user_plan_cost_share_overrides WHERE user_id=u;
  IF n<>0 THEN RAISE EXCEPTION 'FK cascade fail (% left)',n; END IF;
END \$\$;"
P -f "$MIG" >/dev/null   # idempotency: re-run clean
P -c "
ALTER TABLE public.claim_line_items DROP COLUMN IF EXISTS member_applied_to_deductible, DROP COLUMN IF EXISTS member_coinsurance, DROP COLUMN IF EXISTS member_copay, DROP COLUMN IF EXISTS denied_amount, DROP COLUMN IF EXISTS network_status;
ALTER TABLE public.claims DROP COLUMN IF EXISTS network_status, DROP COLUMN IF EXISTS user_network_override;
DROP TABLE IF EXISTS public.claim_accumulators;
DROP TABLE IF EXISTS public.user_plan_cost_share_overrides;
DELETE FROM feature_flag_rules WHERE flag_key='recovery_cost_share_v2';"
echo ">>> COST-SHARE-V2 MIG174 FIXTURE: PASS <<<"
