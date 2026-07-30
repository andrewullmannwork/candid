-- =============================================================================
-- MIGRATION 218 — canonical-link confidence + `plan_identity_resolver_v1` flag
-- (S292 — item 4B: make the plan-identity resolver's strongest rules able to
-- fire at all)
-- =============================================================================
--
-- WHY THE COLUMN EXISTS
-- `src/lib/plan/plan-identity.ts` decides "is this uploaded document the same
-- plan the user already has?" Its two strongest rules — rule 1 (same canonical
-- plan => SAME) and rule 5 (different canonical plan => DIFFERENT) — are gated
-- behind a confidence floor, because a canonical link is itself a fuzzy match
-- and a wrong link would confidently suppress a prompt the user needed:
--
--     canonicalUsable() := canonical_plan_id IS NOT NULL
--                          AND confidence IS A NUMBER
--                          AND confidence >= floor
--
-- An ABSENT confidence is deliberately treated as UNKNOWN, never as certain.
--
-- `insurance_plans` stored `canonical_plan_id` and nothing else. Every one of
-- the SEVEN code paths that links a plan to a canonical computed a real match
-- confidence (0.95 for a group-number or HIOS exact match, the fuzzy score for
-- a scored match, 0.5 for a freshly created canonical) and then DISCARDED it —
-- it was logged and dropped on the floor. So `canonicalUsable()` returned false
-- on every row in the table, and the resolver could only ever fall through to
-- name comparison: precisely the thing it was built to replace.
--
-- This is the mig-217 lesson in a second location. There the fix was to stamp
-- provenance at WRITE time so fabricated and user-entered rows stay
-- distinguishable forever; here it is the same shape — the information exists
-- at the moment of the write and is only unrecoverable because nobody wrote it
-- down. A link without its confidence is like a billing code without its code
-- type (Data Rule #3): the PAIR is the unit of identity, and half of it is not
-- a weaker fact, it is an unusable one.
--
-- BACKFILL: deliberately NONE. Existing rows keep `canonical_match_confidence`
-- NULL, which reads as UNKNOWN and falls through to the weaker identity rules
-- (which can still reach "uncertain" and ASK). Inventing a retroactive score
-- for links whose evidence we no longer hold would be manufacturing the exact
-- kind of confident-looking fiction this column exists to prevent. Rows earn a
-- confidence the next time a document re-links them.
--
-- WHAT THE FLAG GATES
-- `plan_identity_resolver_v1` gates routing the upload merge/mismatch decision
-- through `resolvePlanIdentity` instead of the legacy five-word-strip plan-name
-- comparison against the PROFILE. OFF = the legacy path, byte-identical.
--
-- `config.canonical_confidence_floor` makes Andrew's 0.85 floor tunable without
-- a deploy (Block Ship Gate #6 — no hardcoded thresholds). Absent/invalid config
-- falls back to the CANONICAL_IDENTITY_CONFIDENCE_FLOOR constant (0.85).
--
-- DEFAULT: OFF. It changes which uploads merge into the user's active plan and
-- which are held for confirmation — the widest blast radius on the upload path.
--
-- APPLY (Studio, one paste): strip comments before pasting, then run the
-- verifies below. Additive only (Data Rule #7): one nullable column + one CHECK
-- + one flag row. No backfill, no DROP, no type change, no trigger.
--
-- VERIFY 1 — column exists, nullable, no default:
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'insurance_plans'
--     AND column_name = 'canonical_match_confidence';
--   -- expect: numeric | YES | NULL
--
-- VERIFY 2 — every existing row is UNKNOWN, nothing was invented:
--   SELECT count(*) AS total,
--          count(canonical_plan_id) AS linked,
--          count(canonical_match_confidence) AS scored
--   FROM insurance_plans;
--   -- expect: scored = 0 immediately after apply
--
-- VERIFY 3 — flag seeded OFF with the floor in config:
--   SELECT flag_key, enabled, target_type, config
--   FROM feature_flag_rules WHERE flag_key = 'plan_identity_resolver_v1';
--   -- expect exactly one row: enabled=f, target_type=global,
--   --                         config={"canonical_confidence_floor": 0.85}
--
-- ROLLBACK (row removal forbidden per Pattern 1 #10 hard-delete prohibition;
-- the column is additive and inert while the flag is OFF, so it stays):
--   UPDATE feature_flag_rules SET enabled = false
--   WHERE flag_key = 'plan_identity_resolver_v1';
-- =============================================================================

ALTER TABLE insurance_plans
  ADD COLUMN IF NOT EXISTS canonical_match_confidence NUMERIC;

ALTER TABLE insurance_plans
  DROP CONSTRAINT IF EXISTS insurance_plans_canonical_match_confidence_range;

ALTER TABLE insurance_plans
  ADD CONSTRAINT insurance_plans_canonical_match_confidence_range
  CHECK (
    canonical_match_confidence IS NULL
    OR (canonical_match_confidence >= 0 AND canonical_match_confidence <= 1)
  );

COMMENT ON COLUMN insurance_plans.canonical_match_confidence IS
  'S292 mig 218. Confidence (0-1) of THIS row''s canonical_plan_id link, stamped by the same write that sets the link (canonicalLinkFields / linkPlanToCanonical in src/lib/plan/canonical-match.ts are the single source). NULL = UNKNOWN, never "certain": pre-mig-218 rows and any link written without evidence stay NULL and are refused by plan-identity.ts canonicalUsable(), which falls through to weaker rules rather than deciding on an unscored link. The (canonical_plan_id, canonical_match_confidence) PAIR is the unit of plan-catalog identity — mirrors Data Rule #3 (billing_code is meaningless without billing_code_type). Values: 0.95 group-number/HIOS exact, fuzzy score for a scored match, 0.5 newly created canonical, 1.0 user-confirmed (human oracle); smart-skip file-hash dedup PROPAGATES the source plan''s value rather than minting one.';

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'plan_identity_resolver_v1',
  false,
  'S292 item 4. Routes the upload merge/mismatch decision through resolvePlanIdentity (canonical -> HIOS -> group+insurer -> insurer family -> canonical-differs -> name -> uncertain) instead of the legacy five-word-strip plan-name comparison against the profile. Fixes both directions of the old check: the FALSE NEGATIVE (a genuinely different plan silently supplement-merged into the active plan because the profile plan_name was empty, so every later bill is audited against a blend of two policies) and the FALSE POSITIVE (a card and an SBC that provably resolve to the SAME canonical plan flagged as a mismatch because the strings read differently). Verdict "same" merges; "different" and "uncertain" both hold the upload as an inactive plan and ask, because preserve-on-uncertainty beats guessing. config.canonical_confidence_floor tunes the confidence a canonical link must clear before it may decide identity (Ship Gate #6 — no hardcoded thresholds); absent/invalid falls back to 0.85. OFF = legacy comparison, byte-identical.',
  'global',
  '{"canonical_confidence_floor": 0.85}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
