-- 231 — S319/S320: record WHEN a plan became the active plan.
--
-- WHY. Plan activation is a real user decision with no durable trace: the six
-- activation writers flip `is_active` and move on, so no rule can ever ask
-- "has this user moved on since X?" The first consumer is the stranded-plan
-- offer's Gate 4 (silence the stale "Use the plan you uploaded?" banner once
-- two or more plans arrived-or-activated after the stranded parse — Andrew's
-- "I changed my plan twice, silence it"). The fact generalizes: "which plan
-- was live when" questions recur (plan-year authority is built on that class).
--
-- Deliberately NO backfill: past activations are unknowable, and a guessed
-- timestamp (e.g. updated_at, polluted by every edit) would be fabricated
-- data. NULL = "activation predates the record" and never counts toward any
-- moved-on rule — conservative in the banner's favor.
--
-- The claim-scoped `plan_repinned` spine events are deliberately NOT the
-- source: they fire per-repointed-claim (a switch with no claims leaves
-- nothing; one switch can leave five events), so deriving switch counts from
-- them needs dedupe heuristics — inference dressed as a fact.
--
-- SAFETY. Additive column (Rule #7); no CHECK, no index (Gate 4's per-user
-- scan is ≤ dozens of rows). Code stamps ship in lockstep with this mig —
-- apply BEFORE deploying the stamping code (DEV Studio now; PROD at promote).
--
-- ROLLBACK (documented, not executed):
--   ALTER TABLE public.insurance_plans DROP COLUMN activated_at;

ALTER TABLE public.insurance_plans
  ADD COLUMN IF NOT EXISTS activated_at timestamptz;

COMMENT ON COLUMN public.insurance_plans.activated_at IS
  'S319 mig 231: when this plan last became the ACTIVE plan (stamped by every is_active=true writer). NULL = activation predates the record; never counts toward moved-on rules.';
