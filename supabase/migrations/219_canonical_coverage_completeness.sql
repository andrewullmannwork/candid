-- =============================================================================
-- MIGRATION 219 — `canonical_coverage_completeness_v1` flag seed
-- (S294 — the canonical coverage READ loses columns the table already holds)
-- =============================================================================
--
-- WHAT THIS GATES
--
-- Two changes to the SHARED coverage read path, shipped together because they
-- are the same defect seen from two angles:
--
--   1. READ THE WHOLE ROW. Four call sites read `canonical_plan_services`, each
--      with its own hand-written column list. Three of them omit
--      `in_deductible_applies`. So the claim page, the needs panel, the audit
--      and the dispute letter receive "$0 copay, deductible treatment unknown"
--      for a row whose SBC excerpt plainly reads "No Charge AFTER deductible" —
--      and the engine then INFERS the missing half. `/plan` and `/compare`
--      select the full row and are correct, so the same plan reads two
--      different ways depending on which surface you are looking at.
--
--      `PlanCoverageInput.deductibleApplies` already exists and is documented
--      as "carried through the coverage cascade (exact -> secondary -> ACA)".
--      The cascade was built to carry this. One loader stopped filling it and
--      three inherited the gap. Nothing new is introduced here — a field the
--      type already declares and the engine already reads gets populated.
--
--   2. CANONICAL GAP-FILLS INSTEAD OF ALL-OR-NOTHING. `loadPlanCoverageMeta`
--      is either/or today: ZERO user-scoped coverage rows -> inherit canonical;
--      ANY user-scoped rows -> ignore canonical entirely. So uploading a plan
--      document can REMOVE coverage the user could see the day before: the
--      moment one `plan_covered_services` row exists, the canonical vanishes
--      wholesale and any service the uploaded document happens not to enumerate
--      goes dark.
--
--      New rule — the supplement-merge policy (S286 `plan-merge.ts`) applied to
--      the READ path, which is where it always belonged:
--        * the user's own documents WIN on every service they cover, always;
--        * canonical fills ONLY slugs the user rows do not mention;
--        * filled rows stay tagged `canonical_inherited`, so provenance stays
--          visible and the letter layer keeps gating on it exactly as it does
--          now.
--      Fill gaps, never erase. Same rule the write path already follows.
--
-- ⚠ NOT IN SCOPE — the ACA question. `resolveSecondaryCoverage`'s preventive
-- backstop stays CONFIRMED-ACA-ONLY (Andrew's S154 direction, reaffirmed at
-- S294). A metal level is NOT an ACA entailment: large-group and self-insured
-- plans are marketed with tier names, grandfathered plans are exempt from
-- §2713, short-term products borrow the vocabulary, and our `metal_level`
-- column is parser-populated from document text — it records what the document
-- said, not the plan's regulatory status. The preventive fix here comes from
-- the plan's OWN words (`in_deductible_applies = false`, carrying its SBC
-- excerpt), not from a statutory assumption.
--
-- WHY A FLAG
-- Both changes shift cost-share verdicts for real users on the widest-read path
-- in the product (claim detail, claims list, discrepancy engine, audit,
-- dispute letter). OFF = today's behavior, byte-identical.
--
-- DEFAULT: OFF. Flip only after a PROD smoke, same discipline as
-- `plan_identity_resolver_v1` (mig 218).
--
-- APPLY (Studio, one paste): strip comments before pasting, then run VERIFY.
-- Additive only (Data Rule #7): one flag row. No column, no backfill, no
-- trigger, no type change.
--
-- VERIFY — flag seeded OFF, global:
--   SELECT flag_key, enabled, target_type, config
--   FROM feature_flag_rules WHERE flag_key = 'canonical_coverage_completeness_v1';
--   -- expect exactly one row: enabled=f, target_type=global, config={}
--
-- ROLLBACK (row removal forbidden per Pattern 1 #10; the flag is inert while
-- OFF, so it stays):
--   UPDATE feature_flag_rules SET enabled = false
--   WHERE flag_key = 'canonical_coverage_completeness_v1';
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'canonical_coverage_completeness_v1',
  false,
  'S294. Gates two changes to the shared canonical coverage read: (1) ONE canonical SELECT + mapper carrying every decision-relevant column — in_deductible_applies, out_*, requires_referral, prior_auth_required, visit_limit, place_of_service, component — replacing four hand-written column lists, three of which dropped in_deductible_applies and forced the engine to infer a value the table already held; plus deterministic variant ordering so a multi-variant slug stops resolving by Postgres heap order. (2) Canonical coverage GAP-FILLS under user-scoped rows instead of the all-or-nothing rule (zero rows -> inherit, any rows -> ignore), which let a plan-document upload silently remove coverage the user could previously see. User documents always win on the services they cover; canonical fills only unmentioned slugs; filled rows stay tagged canonical_inherited. This is the S286 supplement-merge policy (fill gaps, never erase) applied to the read path. Does NOT touch the ACA preventive backstop, which stays confirmed-ACA-only per S154. OFF = today''s behavior, byte-identical.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
