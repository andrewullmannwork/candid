-- Ing-G.2/3 — Adversarial-PDF Assessment (S170)
-- Seeds the `adversarial_pdf_detection` rule flag that gates the artifact +
-- structural adversarial-upload scorer (src/lib/parser/adversarial-pdf.ts).
-- Follows the established flag+config shape (mig 143/144): target_type + config
-- JSONB, flag_key UNIQUE.
--
-- The flag is the MASTER GATE:
--   enabled = false  → scorer never runs → BYTE-IDENTICAL ingest (default).
--   enabled = true   → scorer runs; behavior read from config.mode:
--                        "shadow"  (default) = score + write documents.metadata
--                                  telemetry, NOT surfaced to admins (measure FP
--                                  on real traffic before acting — the G7 closure
--                                  for the ~0-users calibration caveat).
--                        "enforce" = also route flagged docs to the admin
--                                  /admin/documents/review work-list.
--   NEVER auto-rejects — admin-review only at MVP (false-positive cost on
--   legit-unusual SBCs is too high pre-scale).
--
-- config JSONB (empty here → code defaults in DEFAULT_ADVERSARIAL_CONFIG apply;
-- loadAdversarialPdfConfig overlays any overrides — Ship Gate G6 tunability):
--   { "mode": "shadow"|"enforce",
--     "threshold": 0.2,                         -- S170 corpus-validated operating point
--     "weights": { "structural":0.45,"fonts":0.30,"thin":0.13,"producer":0.12 },
--     "sparseFontMax":5, "thinPageMax":2, "minTextForStructural":500,
--     "syntheticProducers":["pdf-lib","skia","quartz"] }
--
-- Rollout: enabled=false → (flip) enabled=true [shadow] → observe → set
--          config.mode="enforce". Rollback at any stage = enabled=false.
--
-- Rollback (full): DELETE FROM feature_flag_rules WHERE flag_key = 'adversarial_pdf_detection';

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'adversarial_pdf_detection',
  false,
  'Ing-G.2/3 (S170). Gates the adversarial-PDF assessment scorer at document ingest (artifact + federal-SBC-structural fusion → documents.metadata.adversarial_pdf_assessment). enabled=false → byte-identical. enabled=true → config.mode shadow (telemetry-only, default) | enforce (admin work-list). Never auto-rejects. Thresholds/weights tunable via config JSONB (G6).',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
