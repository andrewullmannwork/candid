-- =============================================================================
-- MIGRATION 235 — the DFY operator lane (S330, PR-DFY-1; handoff §3 P0)
-- =============================================================================
--
-- The do-it-for-you matter is an ORDINARY claim + dispute row with an
-- ENGAGEMENT overlay — never a parallel data model. This migration adds only
-- what the overlay needs:
--
--   1. claim_case_events.actor gains 'operator' — an operator's act on a
--      member's case is a tagged entry on the SAME timeline the member sees
--      ("Done by Candid · date"). Additive widening of the closed set.
--   2. users.is_operator — the named operator privilege. NEVER overload
--      is_admin: the record must read "an operator acted under this grant",
--      not "an admin did this". Admins may ALSO use the DFY section (Andrew,
--      S330 decision 3), but the operator column is what the role means.
--   3. dfy_engagements — the grant row. One live engagement per claim. Carries
--      the payer seam from day one (R17: member_paid | sponsor_paid + a sponsor
--      reference; a sponsors TABLE waits for the first signed sponsor
--      agreement), the operator who HOLDS the matter (the claim mechanic —
--      the route layer accepts actions only from the holder), the member's
--      state + plan classification snapshotted at intake, the Gates 0–6
--      results (JSONB, Rule #9 first), and the consent-event references the
--      paper stack (PR-DFY-2) fills in.
--   4. consent_type ENUM gains the five DFY instrument values (PR-DFY-2) —
--      the signing pipeline is the platform's own consent_events mechanic.
--   4b. dfy_sponsors + dfy_engagements.sponsor_id — the sponsor lane's
--      paper-before-code rule as a table (R17).
--   5. The dfy_operator_v1 flag seed (OFF/global) with its config — every cap
--      and window config-backed (Ship Gate G6): concurrent cap PER OPERATOR,
--      the R18 refusal runway (business days), the D8 IP allowlist, and the
--      Gate-6 marketing attestation date (null = the gate fails closed and
--      intake refuses every applicant until the approved copy sweep ships),
--      the member-paid fee in cents (0 = the free pilot; the $5 charge flips
--      on counsel's opinion signature), and the who-is-named designation
--      variant per channel (individual | entity; counsel Q2).
--
-- ERASURE: user_id CASCADE — the CHD right-to-erasure covers the grant row
-- natively (E1–E4). operator_user_id SET NULL — deleting an operator account
-- never deletes a member's engagement history.
--
-- APPLY (Supabase Studio): paste the statements as BARE SQL — strip these
-- leading `--` comment lines (the "success-but-nothing" Studio trap). DEV may
-- be applied via the exec_sql RPC from the migration file verbatim.
--
-- ROLLBACK:
--   (enum values cannot be dropped in PostgreSQL; they are inert if unused)
--   DELETE FROM public.feature_flag_rules WHERE flag_key = 'dfy_operator_v1';
--   ALTER TABLE public.dfy_engagements DROP COLUMN IF EXISTS sponsor_id;
--   DROP TABLE IF EXISTS public.dfy_sponsors;
--   DROP TABLE IF EXISTS public.dfy_engagements;
--   ALTER TABLE public.users DROP COLUMN IF EXISTS is_operator;
--   ALTER TABLE public.claim_case_events DROP CONSTRAINT IF EXISTS claim_case_events_actor_known;
--   ALTER TABLE public.claim_case_events ADD CONSTRAINT claim_case_events_actor_known
--     CHECK (actor IN ('user', 'system', 'backfill'));
--   (the last step requires that no actor='operator' rows exist — delete them first.)
-- =============================================================================

ALTER TABLE public.claim_case_events DROP CONSTRAINT IF EXISTS claim_case_events_actor_known;

ALTER TABLE public.claim_case_events ADD CONSTRAINT claim_case_events_actor_known
  CHECK (actor IN ('user', 'system', 'backfill', 'operator'));

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_operator boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.is_operator IS
  'S330 (mig 235) — the DFY operator role: access to the /admin/dfy section only (admins have the same permissions there). Never overload is_admin.';

CREATE TABLE IF NOT EXISTS public.dfy_engagements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'eligibility_pending'
    CONSTRAINT dfy_engagements_status_known
    CHECK (status IN ('eligibility_pending', 'signed', 'active', 'converted', 'terminated', 'completed')),
  lane text NOT NULL DEFAULT 'insurer'
    CONSTRAINT dfy_engagements_lane_known
    CHECK (lane IN ('insurer')),
  payer text NOT NULL DEFAULT 'member_paid'
    CONSTRAINT dfy_engagements_payer_known
    CHECK (payer IN ('member_paid', 'sponsor_paid')),
  sponsor_ref text,
  operator_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  member_state text,
  plan_classification jsonb,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  intake jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent_event_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  signed_at timestamptz,
  activated_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dfy_engagements_user
  ON public.dfy_engagements (user_id);

CREATE INDEX IF NOT EXISTS idx_dfy_engagements_status
  ON public.dfy_engagements (status, created_at);

CREATE INDEX IF NOT EXISTS idx_dfy_engagements_operator
  ON public.dfy_engagements (operator_user_id)
  WHERE operator_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_dfy_engagements_live_claim
  ON public.dfy_engagements (claim_id)
  WHERE status IN ('eligibility_pending', 'signed', 'active');

ALTER TABLE public.dfy_engagements ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.dfy_engagements FROM anon, authenticated;

COMMENT ON TABLE public.dfy_engagements IS
  'S330 (mig 235) — the DFY engagement grant: an overlay on an ordinary claim + dispute row. Server-only writes via operatorScoped / userScoped (B9); one live engagement per claim; payer seam (member_paid | sponsor_paid); operator_user_id = the holder (claim mechanic). RLS enabled with no policies = deny all non-service access.';

-- The SPONSOR lane's paper-before-code rule made structural (R17: a signed
-- sponsor agreement before any sponsor code exists): a sponsor code is accepted
-- at intake ONLY when a dfy_sponsors row carries it with agreement_signed_at
-- set and active = true. Sponsors are reference data (admin-curated), never
-- member-owned; the engagement keeps sponsor_ref (the code as typed) AND the
-- resolved sponsor_id. Reporting to a sponsor is AGGREGATE ONLY (>= 5 rule).
CREATE TABLE IF NOT EXISTS public.dfy_sponsors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  contact_email text,
  agreement_signed_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.dfy_sponsors ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.dfy_sponsors FROM anon, authenticated;

COMMENT ON TABLE public.dfy_sponsors IS
  'S330 (mig 235) — DFY sponsors (employer / plan-sponsor payers, R17 Path C). Admin-curated reference data; a code is valid only with agreement_signed_at set + active. Sponsor reporting is aggregate-only (>= 5).';

ALTER TABLE public.dfy_engagements ADD COLUMN IF NOT EXISTS sponsor_id uuid REFERENCES public.dfy_sponsors(id) ON DELETE SET NULL;

-- The five DFY instruments are consent_events rows (the platform's own e-sign
-- mechanic), and consent_events.consent_type is an ENUM — so the vocabulary
-- must widen here, in the same migration the lane ships in. IF NOT EXISTS makes
-- each idempotent. (ALTER TYPE … ADD VALUE commits with the transaction; the
-- app only writes these values after deploy, so a single Studio paste is safe.)
ALTER TYPE public.consent_type ADD VALUE IF NOT EXISTS 'dfy_authorization_hipaa_cmia';

ALTER TYPE public.consent_type ADD VALUE IF NOT EXISTS 'dfy_authorized_representative_designation';

ALTER TYPE public.consent_type ADD VALUE IF NOT EXISTS 'dfy_scope_of_engagement';

ALTER TYPE public.consent_type ADD VALUE IF NOT EXISTS 'dfy_fee_agreement';

ALTER TYPE public.consent_type ADD VALUE IF NOT EXISTS 'dfy_sponsor_paid_disclosure';

INSERT INTO public.feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'dfy_operator_v1',
  false,
  'S330 (PR-DFY-1). Gates the do-it-for-you operator lane: the /admin/dfy queue + intake screening + matter view, the operator action routes, and the engagement lifecycle. Config: concurrent_cap (per operator), refusal_runway_business_days (R18 intake refusal), ip_allowlist + ip_allowlist_enforced (D8 access hardening), marketing_gate_verified_on (Gate 6 attestation date; null = every applicant refused). OFF = the section is dark and every operator route answers 404. Rollback = flip OFF.',
  'global',
  '{"concurrent_cap": 5, "refusal_runway_business_days": 10, "ip_allowlist": [], "ip_allowlist_enforced": false, "marketing_gate_verified_on": null, "fee_cents": 0, "ops_channel_id": "C0BUFNW7VQE", "designation_named_party": {"erisa_plan": "entity", "plan_internal_grievance": "entity"}}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
