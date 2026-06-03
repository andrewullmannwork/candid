-- =============================================================================
-- MIGRATION 139 — Compare v2 redesign: rollout gate + premium flywheel (PR4)
-- =============================================================================
--
-- Seeds the single feature_flag_rules row that gates the Compare v2 redesign
-- (frontend workstream; plans/compare_v2_redesign.md §4.4/§7). Mirrors the
-- mig 134/136 flag-seed shape (target_type + config JSONB; flag_key sole UNIQUE).
--
-- (Mig number 139 — assigned by Andrew with a buffer; 137/138 reserved for the
--  parallel backend workstream. See plans/workstream_coordination.md.)
--
-- WHY THIS MIGRATION EXISTS
--
-- PR2 ships the Compare results reskin (copay mode) — summary cards, THE NUMBERS,
-- SERVICE BREADTH, and the service-by-service accordions with distinct na/nc/unk
-- empty states — behind this flag. The flag is the kill-switch / rollout gate for
-- the whole v2 redesign arc (PR2 results reskin → PR3 bill mode → PR4 Yearly Lens
-- → PR5 picker + sessions → PR6 upload reskin). A single source of truth for
-- "is Compare v2 on" so the reskinned surfaces can never half-render.
--
-- WHAT THIS MIGRATION ADDS
--
--   feature_flag_rules:
--     compare_v2_redesign  enabled=false  target_type=global  config={}
--
-- BEHAVIOR
--
--   OFF (default): the existing /compare results view (S70 + B3.3) renders
--     byte-identical — PlanSummaryCards + NumbersTable + BreadthTable +
--     ServiceCategoryAccordions, exactly as in PROD today. Graceful degradation:
--     the page reads this flag from feature_flag_rules at render time and falls
--     back to OFF when the row is absent or the read fails (no crash). This means
--     the UI is safe to ship even before this row exists.
--   ON: the v2 reskin (src/components/compare/v2/*) renders instead — same data,
--     same /api/plan/compare payload, new presentation + distinct na/nc/unk empty
--     states. Flip per the staged-rollout discipline when ready.
--   Emergency revert:
--     UPDATE feature_flag_rules SET enabled = false
--       WHERE flag_key = 'compare_v2_redesign';
--
--   CONFIG JSONB — intentionally empty ({}) at PR2. PR2 (copay mode) consumes no
--   tunable thresholds, so seeding any would be config that nothing reads. PR4
--   (Yearly Lens) populates this row with the basket / reference-price / family
--   deductible+OOP tunables (Ship Gate G6 — no hardcoded constants in the live
--   yearly estimate). The yearly-model reader added in PR4 will read this config
--   with per-field fallback to the code defaults in src/components/compare/
--   yearly-model.ts (same loadStrengthConfig / loadSecondaryGate pattern), so an
--   empty config is always safe. Populate then via:
--     UPDATE feature_flag_rules
--       SET config = jsonb_set(config, '{referencePrices,pcp}', '180')
--       WHERE flag_key = 'compare_v2_redesign';
--   (no code deploy needed.)
--
-- BACKOUT — flag row only; DELETE the row to remove. With compare_v2_redesign
-- absent, isFeatureEnabled returns false and the browser flag read resolves to
-- OFF → the existing results view renders (status quo). Safe.

BEGIN;

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'compare_v2_redesign',
  false,
  'Compare v2 redesign (S157). Rollout gate for the /compare reskin arc — PR2 results reskin (copay mode: summary cards + THE NUMBERS + SERVICE BREADTH + service accordions with distinct na/nc/unk empty states) → PR3 bill mode → PR4 Yearly Lens → PR5 picker + localStorage sessions → PR6 upload reskin. Default OFF. OFF preserves today''s results view byte-identical (graceful degradation: the page reads this row at render time and falls back to OFF when absent). When ON, src/components/compare/v2/* renders instead — same /api/plan/compare payload, new presentation. config JSONB empty at PR2; PR4 populates basket/reference/family tunables (Ship Gate G6). See plans/compare_v2_redesign.md §4.4/§7.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

-- =============================================================================
-- PR4 (S158) — Compare premium-observation flywheel (user-scoped write path)
--               + the admin-adjustable community minimum.
-- =============================================================================
-- Pattern 1 #14 / Rule #5 / Rule #10: USER-SCOPED writes only. Every confirmed/
-- entered premium in Compare records one row tagged to the plan. The ≥N k-anon
-- aggregation read-back (→ the "Community" premium suggestion tier) is a deliberate
-- FOLLOW-UP — N is COMPARE_FLYWHEEL_MIN_MEMBERS below, adjustable in /admin/settings.
-- No canonical write; no cross-user read. Idempotent (re-runnable).

CREATE TABLE IF NOT EXISTS compare_premium_observations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canonical_plan_id  uuid REFERENCES canonical_plans(id) ON DELETE SET NULL,
  insurance_plan_id  uuid REFERENCES insurance_plans(id) ON DELETE SET NULL,
  plan_label         text,
  metal_level        text,
  state              text,
  premium_monthly    integer NOT NULL CHECK (premium_monthly >= 0),
  incl_employer      boolean NOT NULL DEFAULT false,
  source             text NOT NULL DEFAULT 'compare_user_entry',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cpo_canonical_created
  ON compare_premium_observations (canonical_plan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cpo_user
  ON compare_premium_observations (user_id);

-- Service-role-only writes (via POST /api/compare/premium-observation). RLS ON
-- with no anon/auth policies → individual rows are never exposed cross-user
-- (Rule #5); aggregation, when built, runs service-role + k-anon ≥ N.
ALTER TABLE compare_premium_observations ENABLE ROW LEVEL SECURITY;

-- Admin-adjustable community minimum (k-anon floor) for the flywheel aggregation.
-- Lives in the feature_flags KV store so it's editable at /admin/settings with no
-- deploy. Default 5 (Rule #5). Read via getFlags().COMPARE_FLYWHEEL_MIN_MEMBERS.
INSERT INTO feature_flags (key, value, description)
VALUES (
  'COMPARE_FLYWHEEL_MIN_MEMBERS',
  '5',
  'Compare premium flywheel: minimum distinct member observations on a plan before a community-average premium is shown (k-anonymity floor, Rule #5). Adjustable in /admin/settings.'
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
