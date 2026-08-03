-- =============================================================================
-- MIGRATION 224 — Letter requirements v1 feature flag (S301)
-- =============================================================================
--
-- Seeds the `letter_requirements_v1` row in `feature_flag_rules`. Gates the
-- re-key of "what does THIS letter need from the user" onto `letterNeeds`
-- (src/lib/disputes/letter-type.ts), which is derived from the letter composer's
-- own recipient decision rather than re-deriving it.
--
-- WHAT IT FIXES. The gap emitter and the MVDL readiness floor each answered the
-- recipient question independently, with a BINARY test
-- (`letterType !== "insurance_appeal"`), while the composer (index.ts) and the
-- templates already had three recipient kinds. Consequences, all live:
--   - debt_validation was asked for a PROVIDER address it never prints, was
--     never offered the COLLECTOR address it does print, and failed MVDL #3 for
--     the missing provider address → "Not ready to send" on a correct letter
--   - external_review (insurer-directed) was asked for a provider address and
--     NEVER for the appeals address it must be mailed to
--   - the legal Case File's "What Would Strengthen This" printed those same
--     irrelevant open items
--   - the needs panel's own INSURER_TRACK was a THIRD definition of "insurer
--     letter" (it included final_notice, which the recipient map calls a
--     provider letter and the deadline engine excludes), so the denial-date row
--     rendered on two letter types where nothing consumes it
--
-- ⚠ USER-VISIBLE SCORING CHANGE — this is why it gets its own flag rather than
-- riding `case_rail_v1`. The readiness tier ("Not ready to send" / "Ready to
-- send") is rendered copy, and the correction moves letters in BOTH directions:
--   UP   — a debt_validation with a collector address but no provider address
--          stops failing the floor
--   DOWN — an external_review with a provider address but NO appeals address
--          currently PASSES the floor and will correctly start failing it
-- The down-direction move is the point (an external review cannot be mailed
-- without the appeals address) but it must be flipped deliberately, with a
-- before/after count in hand, not arrive as a side effect of promoting the
-- timeline rebuild.
--
-- OFF = byte-identical: `computeEvidenceGaps` runs the pre-S301 binary, the
-- readiness floor keeps its legacy recipient mapping (including `collector`
-- falling to the both-addresses branch), and CaseNeedsPanel renders its legacy
-- row set. The collections rows (collector address, account / reference number)
-- do not render. Client reads go through GET /api/feature-flags/
-- letter_requirements_v1 (key added to EXPOSED_FLAGS in the same PR).
--
-- NOT GATED BY THIS FLAG (correctness fixes in shared code, named in the PR):
--   - `letterRecipientKind("external_appeal")` returned "provider" because the
--     raw dispute_type missed the lookup table; both the [disputeId] GET and the
--     case-file route pass the raw type in. Now normalized through one shared
--     alias map.
--   - the claim-scoped collector knowledge layer (`claims.metadata.collector`),
--     which is additive and reads as absent when unset.
--
-- ROLLOUT: merge OFF → DEV Studio-apply + DEV flag-ON E2E pre-merge → PROD
-- Studio-apply at promote → prod flag-OFF smoke → separate Andrew go for the
-- PROD flip, with the before/after readiness-tier count run first.
--
-- ROLLBACK: flip flag OFF (UPDATE feature_flag_rules SET enabled=false WHERE
-- flag_key='letter_requirements_v1') — gaps, readiness floor, and the panel row
-- set all return to today's behavior. No data migration to unwind: the
-- collections fields are additive JSONB that simply stops being read.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'letter_requirements_v1',
  false,
  'S301 (2026-08-02). Letter requirements v1 — each letter asks only for what THAT letter needs, keyed on letterNeeds (derived from the composer''s own recipient decision) instead of a binary letterType test. Fixes: collector letters asked for a provider address and scored "Not ready to send" for missing it; external reviews asked for a provider address and never for the appeals address; the legal Case File printed irrelevant open items; the needs panel''s INSURER_TRACK was a third, disagreeing definition of "insurer letter". Adds the collections rows (collector address, account/reference number) backed by the claim-scoped collector knowledge layer so the user types the agency once per bill. ⚠ Moves the user-visible readiness tier in BOTH directions — external reviews missing an appeals address correctly start failing the MVDL floor. OFF = byte-identical gaps, floor, and panel row set.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

-- Verify:
-- SELECT flag_key, enabled, target_type, config FROM feature_flag_rules WHERE flag_key = 'letter_requirements_v1';
-- Expect: 1 row, enabled = false, target_type = 'global', config = {}.
