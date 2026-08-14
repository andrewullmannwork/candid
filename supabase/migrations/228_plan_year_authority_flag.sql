-- =============================================================================
-- MIGRATION 228 — Plan-year authority feature flag (S313)
-- =============================================================================
--
-- Seeds `plan_year_authority_v1`. ONE rule, three surfaces: a plan document is
-- authority only for care delivered in ITS OWN plan year.
--
-- WHAT IT FIXES. The wrong-year apparatus already existed (S110/S111) — the
-- reverse-burden letter clause asking the insurer to produce the bill-year SPD
-- under 29 USC §1024(b)(4), and the "Upload your <year> plan" evidence gap. Both
-- were keyed on `missingForYear`, which `plan-context.ts` sets ONLY when NO plan
-- resolved for the claim year:
--
--     const missingForYear = planYear != null && !resolvedPlan ? planYear : null;
--
-- and on `hasExactPlan` in templates.ts, which is `!!planContext?.plan` — true
-- for ANY resolved plan, whatever year it belongs to. So "I have no plan for
-- that year" was covered and "the plan I have is from a DIFFERENT year" was not.
--
-- A 2024 bill pinned to a 2026 plan therefore took the exact-plan path: per-line
-- bullets quoting the 2026 Summary of Benefits verbatim as the authority for
-- 2024 care, with no year caveat. An insurer can dismiss that on the date alone.
-- Live in PROD (S313 smoke, claim 046f64cd: DOS 2024-07-01, plan_year 2026), and
-- REACHABLE BY DESIGN — `dispute_plan_pinning_v1` is ON and the accumulator's
-- plan-change ask invites exactly this pin.
--
-- WHAT THE FLAG TURNS ON.
--   1. Year-aware plan resolution: a resolved plan whose year differs from the
--      service year no longer satisfies "exact", and sets `missingForYear`. The
--      EXISTING reverse-burden letter clause + evidence gap light up on their
--      own — no new letter copy.
--   2. The plan-change ask warns before a year-mismatched move, and a "Keep on
--      the old plan" choice PERSISTS (plan-pair scoped, user-scoped) so the ask
--      retires instead of returning every visit.
--
-- NOT GATED, and deliberately so: the same PR corrects the ask's three-valued
-- choice, its button copy, and Done-gating. Those are fixes to a reported
-- defect (a boolean could not tell "undecided" from "explicitly keep", so the
-- Keep button painted grey before any click and an explicit Keep was skipped by
-- the apply loop). Hiding a bug fix behind a flag would keep the broken modal
-- alive as a maintained code path.
--
-- ⚠ LETTER OUTPUT CHANGES for wrong-year-pinned claims: the verbatim wrong-year
-- citation is replaced by the reverse-burden ask. Goldens re-baselined and
-- LETTER_COMPOSE_VERSION bumped in the same commit (standing discipline). With
-- `dispute_draft_live_rebuild_v1` ON, live drafts rebuild silently.
--
-- OFF = year-blind resolution exactly as today, no year warning, no stored
-- answer written or read. NOT byte-identical on the /plan modal, by the design
-- note above: its corrected choice model and copy ship un-gated.
--
-- ROLLOUT: merge OFF → PROD Studio-apply → prod flag-OFF smoke → separate
-- Andrew go for the flip.
--
-- ROLLBACK: UPDATE feature_flag_rules SET enabled=false WHERE
-- flag_key='plan_year_authority_v1'. Stored plan-identity answers become inert
-- data, never read; no data migration to unwind.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'plan_year_authority_v1',
  false,
  'S313 (2026-08-13). Plan-year authority — a plan document is authority only for care delivered in its own plan year. ON: a resolved plan whose year differs from the service year stops satisfying the exact-plan test and sets missingForYear, so the EXISTING S110/S111 reverse-burden clause (produce the bill-year SPD under 29 USC 1024(b)(4)) and the existing "Upload your <year> plan" evidence gap fire on wrong-year PINNED claims, not just on no-plan-for-that-year claims; and the accumulator plan-change ask warns before a year-mismatched move and persists the member''s plan-identity answer (plan-pair scoped, user-scoped) so the ask retires. The same PR''s modal corrections (three-valued choice, button copy, Done-gating) are defect fixes and ship UN-gated. No new letter copy — the wrong-year language already existed and was unreachable. OFF = byte-identical year-blind resolution and today''s modal.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

-- Verify:
-- SELECT flag_key, enabled, target_type, config FROM feature_flag_rules WHERE flag_key = 'plan_year_authority_v1';
-- Expect: 1 row, enabled = false, target_type = 'global', config = {}.
