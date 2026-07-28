-- =============================================================================
-- MIGRATION 216 — `unverified_plan_honesty_gate_v1` flag seed
-- (S291 — Andrew E2E finding #3: "it says the bill is correct which is a silent
-- error since that is not necessarily true")
-- =============================================================================
--
-- WHAT IT GATES
-- The Cost-Share v2 honesty gate (§13.2, recovery-math.ts) already refuses to
-- label a bill `correct` off a GUESSED shouldOwe. It did not consider WHERE the
-- plan terms came from. A plan assembled from a photo of an insurance card is
-- labelled `unverified` on every benefits surface ("your insurance card alone
-- doesn't reveal your specific coverage") — yet the engine would still issue a
-- confident all-clear on a bill audited against it.
--
-- Concretely: a card scan wrote `in_copay: 0, confidence: 1` rows for PCP /
-- specialist / ER. That fabricated "$0 copay, covered" made costShareUnknown
-- false, which made shouldOweGrounded true, which produced "no issues" on a
-- $428 primary-care visit the user had paid $292.41 for.
--
-- ON  -> a `correct`/`confident` verdict computed against an unverified
--        (insurance_card / manual / verification_status='unverified') plan
--        degrades to `insufficient` — "we can't fully check this" — surfacing
--        the already-built V4 banner + "Add plan details" prompt.
-- OFF -> prior behaviour, byte-identical.
--
-- NEVER suppresses a finding: `recovery`, `not_covered` and insurer-denial
-- verdicts pass through untouched with identical dollars, so this can neither
-- hide a dispute nor fabricate one. Absent provenance fails OPEN.
-- Fixture: scripts/s291-plan-honesty-fixture.ts (12 assertions).
--
-- WHY FLAGGED
-- It shifts user-visible verdicts for EVERY card-only user: bills reading
-- "no issues" today will read "we can't fully check this yet". That is the
-- honest answer, but it is a broad behavioural change and must be reversible
-- without a deploy.
--
-- DEFAULT: ON. The alternative is knowingly shipping a silent false-negative.
--
-- APPLY (Studio, one paste): strip comments before pasting + run the verify.
--
-- VERIFY (must return exactly one row, enabled=t, target_type=global):
--   SELECT flag_key, enabled, target_type, config
--   FROM feature_flag_rules WHERE flag_key = 'unverified_plan_honesty_gate_v1';
--
-- ROLLBACK (row removal forbidden per Pattern 1 #10 hard-delete prohibition):
--   UPDATE feature_flag_rules SET enabled = false
--   WHERE flag_key = 'unverified_plan_honesty_gate_v1';
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'unverified_plan_honesty_gate_v1',
  true,
  'S291. Plan-provenance honesty gate. When ON, a bill audited against an UNVERIFIED plan (source insurance_card/manual, or verification_status=unverified) can never read "correct"/"confident" — the Cost-Share v2 verdict degrades to "insufficient" so the user is asked for their plan document instead of being told the bill is fine. Closes the silent false-negative where card-scanned $0 copays (written at confidence 1) grounded a confident all-clear on a bill Candid had not actually checked. NEVER suppresses a finding: recovery / not_covered / denial verdicts pass through with identical dollars; absent provenance fails open. OFF = prior verdict behaviour byte-identical.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
