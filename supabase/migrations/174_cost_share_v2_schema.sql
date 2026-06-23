-- 174_cost_share_v2_schema.sql
-- Cost-Share v2 (S213) — network/deductible/OOP-aware recovery math.
--
-- WHY: the recovery/dispute synthesis is phase-blind (no deductible/network/OOP
-- term) AND the persist layer DROPS the adjudication data the parser already
-- extracts (member-cost-share split, network tier, YTD accumulators). This
-- migration adds the storage for that already-extracted data + the user-scoped
-- assumption-override table that backs the transparent "we assumed…" banner.
--
-- ALL ADDITIVE (Rule #7). Inert until the cost-share-v2 code ships + the
-- `recovery_cost_share_v2` flag is flipped — nothing reads these columns/tables
-- on apply, so applying this to PROD first is byte-identical.
--
-- STUDIO APPLY NOTE (per reference_supabase_studio_migration_apply): run the
-- WHOLE file (BEGIN…COMMIT) — do not partial-select. Verify SELECT at bottom of
-- this message (not committed) confirms the effect.
--
-- Rollback (full):
--   ALTER TABLE public.claim_line_items
--     DROP COLUMN IF EXISTS member_applied_to_deductible,
--     DROP COLUMN IF EXISTS member_coinsurance,
--     DROP COLUMN IF EXISTS member_copay,
--     DROP COLUMN IF EXISTS network_status,
--     DROP COLUMN IF EXISTS denied_amount;
--   ALTER TABLE public.claims DROP COLUMN IF EXISTS network_status, DROP COLUMN IF EXISTS user_network_override;
--   DROP TABLE IF EXISTS public.claim_accumulators;
--   DROP TABLE IF EXISTS public.user_plan_cost_share_overrides;
--   DELETE FROM feature_flag_rules WHERE flag_key = 'recovery_cost_share_v2';

BEGIN;

-- 1 — claim_line_items: the insurer's per-line cost-share split + network +
--     denial (parser extracts all five; persist currently drops them).
--     Nullable, NO default: NULL = "not captured" (legacy rows + sparse bills);
--     0 only when the bill explicitly shows $0 (parser NULL-vs-ZERO discipline).
ALTER TABLE public.claim_line_items
  ADD COLUMN IF NOT EXISTS member_applied_to_deductible NUMERIC,
  ADD COLUMN IF NOT EXISTS member_coinsurance           NUMERIC,
  ADD COLUMN IF NOT EXISTS member_copay                 NUMERIC,
  ADD COLUMN IF NOT EXISTS denied_amount                NUMERIC,
  ADD COLUMN IF NOT EXISTS network_status               TEXT;

ALTER TABLE public.claim_line_items
  DROP CONSTRAINT IF EXISTS claim_line_items_network_status_check;
ALTER TABLE public.claim_line_items
  ADD CONSTRAINT claim_line_items_network_status_check
  CHECK (network_status IS NULL OR network_status IN ('in_network','out_of_network','tiered','unknown'));

COMMENT ON COLUMN public.claim_line_items.member_applied_to_deductible IS
  'Cost-share v2 (mig 174): per-line amount the insurer applied to the deductible (from EOB member breakdown). NULL=not captured; 0=explicit $0.';
COMMENT ON COLUMN public.claim_line_items.member_coinsurance IS
  'Cost-share v2 (mig 174): per-line coinsurance the insurer assigned (EOB member breakdown). NULL=not captured.';
COMMENT ON COLUMN public.claim_line_items.member_copay IS
  'Cost-share v2 (mig 174): per-line copay the insurer assigned (EOB member breakdown). NULL=not captured.';
COMMENT ON COLUMN public.claim_line_items.denied_amount IS
  'Cost-share v2 (mig 174): per-line explicitly denied amount (distinct from $0 paid). NULL=not captured.';
COMMENT ON COLUMN public.claim_line_items.network_status IS
  'Cost-share v2 (mig 174): per-line network tier (in_network|out_of_network|tiered|unknown) — selects in_/out_ plan params. NULL=unknown.';

-- 2 — claims: claim-level default network tier (parser) + the user's per-claim
--     network correction (the banner's network toggle). Distinct columns so a
--     user correction never clobbers the parser's value. Network is a per-CLAIM
--     fact (in/out varies per encounter) — NOT plan-year — so it lives here, not
--     in user_plan_cost_share_overrides.
ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS network_status        TEXT,
  ADD COLUMN IF NOT EXISTS user_network_override TEXT;
ALTER TABLE public.claims DROP CONSTRAINT IF EXISTS claims_network_status_check;
ALTER TABLE public.claims ADD CONSTRAINT claims_network_status_check
  CHECK (network_status IS NULL OR network_status IN ('in_network','out_of_network','tiered','unknown'));
ALTER TABLE public.claims DROP CONSTRAINT IF EXISTS claims_user_network_override_check;
ALTER TABLE public.claims ADD CONSTRAINT claims_user_network_override_check
  CHECK (user_network_override IS NULL OR user_network_override IN ('in_network','out_of_network'));
COMMENT ON COLUMN public.claims.network_status IS
  'Cost-share v2 (mig 174): claim-level default network tier from the parser (line.network_status overrides). NULL=unknown.';
COMMENT ON COLUMN public.claims.user_network_override IS
  'Cost-share v2 (mig 174): user-set per-claim network correction (assumption banner). User-scoped write; engine precedence > line/claim parser network_status. NULL=no override.';

-- 3 — claim_accumulators: per-claim EOB deductible/OOP snapshot (YTD met-status).
--     One row per (claim, 4-dim accumulator key). Confidence + source per Rule #8.
CREATE TABLE IF NOT EXISTS public.claim_accumulators (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id             UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  benefit_year         TEXT NOT NULL,
  network_tier         TEXT NOT NULL CHECK (network_tier IN ('in_network','out_of_network','tiered','unknown')),
  accumulator_type     TEXT NOT NULL CHECK (accumulator_type IN ('medical','rx','dental','vision','combined','mental_health')),
  is_individual        BOOLEAN NOT NULL,
  deductible_applied   NUMERIC,
  deductible_max       NUMERIC,
  oop_applied          NUMERIC,
  oop_max              NUMERIC,
  copays_applied       NUMERIC,
  coinsurance_applied  NUMERIC,
  confidence           NUMERIC,
  source               TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT claim_accumulators_key_unique
    UNIQUE (claim_id, benefit_year, network_tier, accumulator_type, is_individual)
);
CREATE INDEX IF NOT EXISTS idx_claim_accumulators_claim_id
  ON public.claim_accumulators (claim_id);
COMMENT ON TABLE public.claim_accumulators IS
  'Cost-share v2 (mig 174): per-claim EOB accumulator snapshot (deductible/OOP applied vs max, by benefit_year x network_tier x accumulator_type x individual/family). Drives the deductible/OOP phase in recovery-math. Child of claims (user-scoped via parent); populated by the bill parser, never user-facing-write.';

ALTER TABLE public.claim_accumulators ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.claim_accumulators TO service_role;

-- 4 — user_plan_cost_share_overrides: user-asserted PLAN-YEAR facts (deductible-met
--     / OOP-met, with as-of date) from the assumption banner. User-scoped only
--     (Rule #10 / Pattern 1 #14) — NEVER canonical-direct. One row per
--     (user, plan, year); upsert. (Per-claim network correction lives on
--     claims.user_network_override — different grain.)
CREATE TABLE IF NOT EXISTS public.user_plan_cost_share_overrides (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  insurance_plan_id     UUID NOT NULL REFERENCES public.insurance_plans(id) ON DELETE CASCADE,
  plan_year             INTEGER NOT NULL,
  deductible_met        BOOLEAN,
  deductible_met_as_of  DATE,
  oop_met               BOOLEAN,
  oop_met_as_of         DATE,
  source                TEXT NOT NULL DEFAULT 'user_assumption_override',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_plan_cost_share_overrides_key_unique
    UNIQUE (user_id, insurance_plan_id, plan_year)
);
CREATE INDEX IF NOT EXISTS idx_user_plan_cost_share_overrides_user_id
  ON public.user_plan_cost_share_overrides (user_id);
COMMENT ON TABLE public.user_plan_cost_share_overrides IS
  'Cost-share v2 (mig 174): user-asserted PLAN-YEAR deductible-met / OOP-met (with as-of date) from the assumption banner. User-scoped ONLY (Rule #10) — improves the user''s own bills + feeds the anonymized flywheel via separate aggregation; never written to canonical. Per-claim network correction is on claims.user_network_override.';

ALTER TABLE public.user_plan_cost_share_overrides ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.user_plan_cost_share_overrides TO service_role;

-- 5 — feature flag (mig 075/153 shape: target_type + config JSONB; flag_key UNIQUE).
--     OFF = byte-identical (recovery-math v2 never runs). Flip ON only after E2E.
INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'recovery_cost_share_v2',
  false,
  'Cost-Share v2 (S213). Gates network/deductible/OOP-phase-aware recovery math + the transparent assumption banner + user overrides. enabled=false => legacy recovery-math, byte-identical. enabled=true => phase machine + two-tier reconcile/re-derive + assumptions payload.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
