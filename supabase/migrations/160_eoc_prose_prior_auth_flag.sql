-- =============================================================================
-- MIGRATION 160 — eoc_prose_prior_auth_v1 feature flag seed (S190, thesaurus P2)
-- =============================================================================
--
-- Seeds the `eoc_prose_prior_auth_v1` row in `feature_flag_rules`. The flag gates
-- the WHOLE EOC content-type routing divergence (block spec
-- [[eoc_content_type_routing]] §6): the medical_necessity content-type/C1-split
-- prompt (OFF runs the frozen pre-P2 instruction body) AND the routeCriterion
-- dispatch (prose-PA -> typed prior_auth_required column; admin_provision ->
-- insurance_plans.metadata.eoc_coverage_provisions[]; structured
-- eoc_prior_auth_facts[] capture) AND the G7 routing telemetry.
--
-- OFF = instruction-byte-identical to post-D1 routing (fixture-pinned, modulo the
-- always-on D7 cache pad). Documented code-level carve-outs (NOT flag-reversible):
-- D2 documents.metadata read-merge, D5 inert audit fields, D6 accumulate write
-- shape, D7 cache pad — see block spec §6.
--
-- ROLLOUT PLAN (roadmap [[thesaurus_completion_roadmap]] §4 Flip A):
--   1. This migration applies WITH the T6 promote (alongside mig 157), flag OFF.
--   2. Flip ON only after: full T5 floors PASS (Ship Gate G2 — oracle-adjudicated,
--      N=5 de-noised; deferred at the T6 PR per Andrew sign-off) + one real
--      flag-ON EOC parse observed E2E in PROD post-flip.
--   3. Rollback of routing behavior = flip OFF (this row's `enabled` -> false).
--
-- ROLLBACK (of the seed itself):
--   DELETE FROM feature_flag_rules WHERE flag_key = 'eoc_prose_prior_auth_v1';
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'eoc_prose_prior_auth_v1',
  false,
  'S190 (thesaurus P2). Gates the WHOLE EOC content-type routing: the medical_necessity content-type/C1-split prompt (OFF = frozen pre-P2 body, instruction-byte-identical to post-D1 modulo the always-on cache pad) + the routeCriterion type dispatch (prior_auth requires/service-specific/conf>=floor -> typed prior_auth_required column; waived/axis/no-slug/low-conf -> structured eoc_prior_auth_facts[] capture; admin_provision -> insurance_plans.metadata.eoc_coverage_provisions[]) + G7 routing telemetry. Flip ON only after the [[eoc_content_type_routing]] §5 universal eval floors pass (4 carriers, oracle-adjudicated) + one real flag-ON EOC parse verified E2E in PROD. Rollback = flip OFF.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
