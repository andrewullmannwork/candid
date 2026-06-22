-- =============================================================================
-- MIGRATION 168 — Enriched Case File download feature flag (UX bugbash Stretch 2)
-- =============================================================================
--
-- Seeds the `case_file_enriched_v1` row in `feature_flag_rules`. This is a
-- ROLLOUT flag (separate from the Pro entitlement): it controls whether the
-- /disputes "Download Case File" button produces the new enriched PDF (via
-- /api/legal/evidence-package?format=pdf, which is already Pro-gated by
-- FEATURE_ACCESS.documentationAggregation) or the legacy client-side text file.
-- Default OFF so the PR can merge + deploy "dark" before the enriched export is
-- exposed.
--
-- GATING MODEL (two independent layers):
--   - Subscription entitlement: the enriched download routes through
--     /api/legal/evidence-package, which enforces Pro (documentationAggregation).
--     This is the separable monetization gate — to split the Case File onto a
--     different tier later, remap that one FEATURE_ACCESS key.
--   - Rollout flag (THIS row): OFF = current text behavior (merge-dark safe);
--     ON = enriched PDF. Flip global ON post-deploy after the end-of-batch smoke.
--
-- WHAT THE ENRICHED EXPORT ADDS (lawyer-useful sections appended to the
-- evidence package): provider & insurer directory, sibling/peer codes,
-- per-line community outcomes (k-anon >= 5), an evidence-gaps checklist, and a
-- data-sources/confidence note. Honors the no-raw-score (legal L1), k-anon >= 5,
-- and no-other-user-PII constraints (all data already resolver-gated).
--
-- ROLLBACK: flip OFF — the button reverts to the legacy text download. Removal
-- of the row is forbidden per Pattern 1 #10 hard-delete prohibition.
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'case_file_enriched_v1',
  false,
  'UX bugbash Stretch 2. Rollout flag for the enriched /disputes Case File download. When OFF, the Download Case File button produces the legacy client-side text file. When ON, it downloads the enriched PDF via /api/legal/evidence-package?format=pdf (already Pro-gated by FEATURE_ACCESS.documentationAggregation). The enriched package appends: provider/insurer directory, sibling+peer codes, per-line community outcomes (k-anon >= 5), an evidence-gaps checklist, and a data-sources/confidence note. No raw strength scores, no sub-k-anon community data, no other-user PII. Flip global ON post-deploy after smoke.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
