-- =============================================================================
-- MIGRATION 185 — cite_grade_gate_v1 feature flag (S235, Thesaurus A3)
-- =============================================================================
--
-- Seeds the `cite_grade_gate_v1` row in `feature_flag_rules` so the A3 read-layer
-- cite-grade gate can be flipped global ON post-deploy without a code change.
-- Default OFF so the PR merges + deploys byte-identical; flip ON after a real
-- flag-ON parse smoke (the in-vivo synonym cache-win → stamp → gate proof).
--
-- WHAT IT GATES (read-layer consumers of the A3 identity stamp
-- `field_provenance.{field}.resolution_source`, written when thesaurus_phase1a_v1
-- is ON — Step 2):
--   * getDisplayState / decorateFieldFromEntry (src/lib/parser/consumer-read.ts):
--     a cell whose identity was inferred by an UNCONFIRMED synonym cache-win
--     (resolution_source set, identity_confirmed != true) is capped to `estimate`
--     via the §4.1 min() — a confident value under a shaky identity reads estimate,
--     never verified.
--   * isCitationGrade (same file): the SAME inferred cell returns NOT cite-grade,
--     so the dispute-letter blockquote is suppressed (evidence-resolver nulls the
--     excerpt) — referenced, never verbatim-quoted, even WITH a verified excerpt
--     (the excerpt backs the ORIGINAL label, not the remapped concept).
--   * /api/plan/compare (src/lib/plan/compare.ts): sets the existing `inferred`
--     marker `{source:"synonym_cache"}` on such cells → estimate badge + dropped
--     from competitive verdicts (parity with the /plan cap).
--   * /api/plan/analyze (route.ts): cold-start section relabel — the official SBC
--     cold-start seed (source='admin_attested') reads "Coverage details from your
--     plan's official Summary of Benefits" instead of the "other plan members"
--     over-claim; community / user-derived canonical rows keep the neutral label.
--   OFF -> identity axis dormant; read layer byte-identical to today.
--
-- CONFIRM-RELEASE (the design invariant): suppression clears the instant the user
--   confirms the synonym match — the confirm UX (ServiceVerificationGateCard, FE
--   fast-follow) writes `identity_confirmed: true` to the SAME field_provenance
--   cell, so `identity_confirmed != true` flips false on every surface at once.
--
-- INTERLOCK: harmless to flip ON in PROD before synonyms ship — thesaurus_phase1a_v1
--   is OFF, so zero cells carry resolution_source today; the gate is a no-op until
--   the stamp exists. This is the "ships BEFORE A4 Flip B, no uncited-coverage
--   window" property (roadmap §7).
--
-- CONFIG: none (no tunables). `{}` reserved for future per-tier dials.
--
-- ROLLOUT:
--   1. Merge with default OFF.
--   2. Deploy code (flag OFF -> read layer byte-identical).
--   3. Flip global ON after a real flag-ON parse smoke:
--        UPDATE feature_flag_rules SET enabled=true WHERE flag_key='cite_grade_gate_v1';
--
-- ROLLBACK:
--   Flip the flag OFF — the read layer reverts to today's behavior (no-op). Row
--   removal is forbidden per Pattern 1 #10 hard-delete prohibition.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'cite_grade_gate_v1',
  false,
  'S235 (Thesaurus A3). Read-layer cite-grade gate over the synonym identity stamp (field_provenance.resolution_source, written when thesaurus_phase1a_v1 is ON). When ON, a cell whose identity was inferred by an UNCONFIRMED synonym cache-win is capped to estimate (getDisplayState min()) AND is referenced-not-verbatim-cited (isCitationGrade false -> dispute-letter blockquote suppressed), even with a verified coverage excerpt — the excerpt backs the original label, not the remapped concept. /compare sets inferred:synonym_cache (estimate + verdict-exclusion); /plan relabels the official cold-start SBC section (source=admin_attested). Suppression clears when the user confirms the match (identity_confirmed on the same cell — FE fast-follow). OFF = read layer byte-identical. Harmless to flip ON pre-synonyms (thesaurus_phase1a_v1 OFF -> 0 stamped cells). Flip global ON post-deploy after a real flag-ON parse smoke.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
