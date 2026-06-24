-- =============================================================================
-- MIGRATION 176 — plan_doc_extraction_v2 feature flag (S215)
-- =============================================================================
--
-- Seeds the `plan_doc_extraction_v2` row in `feature_flag_rules` so the
-- whole-text-primary plan-document services parser + the codified extraction
-- learnings can be flipped global ON post-deploy without a code change. Default
-- OFF so the PR merges, deploys byte-identical (the established segmented path),
-- and a real flag-ON PROD parse smoke validates the new path before enforcement.
--
-- WHAT IT GATES (src/lib/plan_doc/parser.ts + haiku-prompts/services-cost-sharing.ts):
--   * Whole-text-primary services extraction for small docs (<= config
--     whole_text_max_input_tokens, default 16000 est. tokens) — ONE call over the
--     whole cleaned document so the model sees the plan-level deductible /
--     prior-auth / place context the isolated services section never showed it.
--     Big docs (booklets/EOCs) + OCR-collapse fall back to the established
--     segmented path; hard-truncation (haiku_truncation_at_max) and transient
--     API errors self-heal to segmented.
--   * EXTRACTION_V2_SUPPLEMENT codified learnings: L1 $0/"No charge"->0 (never
--     null) - L2 affirmative not-covered (never a silent blank) - L3 standard
--     in-person line + emit all place-variants - L4 freestanding/ASC ->
--     independent_facility vs hospital outpatient_facility - L5 deductible-applies
--     both networks (cell cues + plan-level cross-ref + copay/coinsurance
--     inference) - L6 $ fee AND % coinsurance both - L7 per-benefit maximums - L8
--     prior-auth "may" -> true + conditional wording.
--   OFF -> byte-identical to the pre-S215 segmented pipeline.
--
-- VALIDATION (19-plan human-adjudicated oracle, fresh re-parse):
--   cost-share 83.8 -> 95.6% (best of all options) - in-ded 99 -> 149 (matches
--   Sonnet) - not-covered 59 -> 61/61 - place 11 -> 21 - zero regressions vs V1.
--
-- CONFIG:
--   whole_text_max_input_tokens (int, default 16000) — input-size ceiling for the
--   whole-text-primary path, read in parser.ts. The 18 sampled SBCs are <= ~8.4K
--   est. tokens; booklets/EOCs and the 436KB Blue Shield doc are well above the
--   gate (-> segmented). Tunable without a deploy.
--
-- ROLLOUT:
--   1. Merge with default OFF.
--   2. Deploy code (flag OFF -> segmented path, byte-identical).
--   3. Flip global ON after a real flag-ON PROD parse smoke:
--        UPDATE feature_flag_rules SET enabled=true WHERE flag_key='plan_doc_extraction_v2';
--
-- ROLLBACK:
--   Flip the flag OFF — the parser reverts to the segmented path (no-op). Row
--   removal is forbidden per Pattern 1 #10 hard-delete prohibition.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'plan_doc_extraction_v2',
  false,
  'S215 (cold-start regen). Whole-text-primary plan-document services parser for small docs (<= config.whole_text_max_input_tokens est. tokens; ONE call over the whole cleaned document so the model sees plan-level deductible/prior-auth/place context) + the EXTRACTION_V2_SUPPLEMENT codified learnings (L1 $0->0, L2 affirmative not-covered, L3 standard line + all place-variants, L4 freestanding->independent_facility vs hospital outpatient_facility, L5 deductible-applies both networks, L6 $ fee AND % coinsurance, L7 per-benefit maximums, L8 prior-auth may). Big docs + OCR-collapse use the established segmented path; hard-truncation/transient-error self-heal to segmented. OFF = byte-identical to the pre-S215 segmented pipeline. Validated on the 19-plan adjudicated oracle: cost-share 83.8->95.6%, in-ded 99->149, not-covered 61/61, no regressions vs V1. Flip global ON post-deploy after a real flag-ON PROD parse smoke.',
  'global',
  '{"whole_text_max_input_tokens": 16000}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
