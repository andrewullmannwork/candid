-- B11 (Session 97) — Multi-column SBC parser fidelity feature flags.
--
-- Closes the 40% service-extraction deficit on multi-column SBC layouts
-- (notably Blue Shield's federal SBCs) by introducing two independently-
-- toggleable mechanisms in the OCR pipeline:
--
--   1. `pdfjs_primary_v1` — when ON, attempt pdfjs text-layer extraction
--      first for PDF uploads (Path F primary). Returns byte-exact text from
--      the PDF's native text layer for digital PDFs (the vast majority of
--      SBCs/EOCs from insurer compliance teams). On low text density
--      (`ImageOnlyPDFError`) or any pdfjs failure, falls back to Google
--      Document AI OCR. Quality improvements:
--        - Byte-exact (no OCR transcription layer) → strictly higher cite-
--          grade fidelity on Pattern P-8 verifier.
--        - Free (no Document AI API call) for ~95% of digital PDFs.
--        - Fast (~100ms vs ~2-5s for Document AI network round-trip).
--        - Naturally column-aware: pdfjs emits text in PDF content stream
--          order, which on federal SBCs is the document author's intended
--          reading order — empirically verified S97 on BS Bronze 60 PPO
--          drug section that the column-interleaving artifact Document AI
--          exhibits is NOT present in pdfjs output. No reflow applied to
--          the pdfjs path.
--
--   2. `ocr_reflow_v1` — when ON, apply the universal column-detect + reflow
--      primitive (`src/lib/ocr/reflow.ts`) to Document AI OCR output. Reads
--      bounding-box data already captured at extraction time and clusters
--      blocks into proper column-aware reading order before downstream
--      Haiku extraction sees the text. Required for image-only PDFs (since
--      pdfjs path can't run); pdfjs path already reflows internally.
--
-- Defaults BOTH flags `enabled=false, target_type='global'`. Migration apply
-- is a no-op for runtime behavior — legacy Document AI raw-text path stays
-- live until admin flips flags. Pattern: mirror mig 099/100 INSERT shape per
-- `feedback_candid_feature_flag_schema`.
--
-- Roll-out plan:
--   1. Apply this migration to dev DB. Verify no behavior change (flags OFF).
--   2. Admin flips `pdfjs_primary_v1` enabled=true global → upload 10
--      fixtures in dev → verify lift on BS (was 23 svc → target ≥38), no
--      regression on Ambetter (35-41 svc preserved), no regression on EOCs.
--   3. Repeat for `ocr_reflow_v1` (covers image-only PDF path).
--   4. PR + release-to-prod with both flags OFF in PROD.
--   5. After PROD soak, admin flips both flags ON globally.
--   6. Kill switch: admin flips either flag enabled=false to revert to
--      legacy Document AI raw-text path. Zero-deploy rollback.
--
-- Pattern P-8 cite-grade safety: each TextBlock's text is byte-exact from
-- its source extractor (pdfjs TextItem or Document AI line). Reflow only
-- changes concatenation order. The verifier byte-exact match against
-- reflowed text remains correct by construction — and improves because
-- column-interleaving structural gaps are eliminated upstream of the
-- verifier's n-gram bridge fallback (S96).

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'pdfjs_primary_v1',
  false,
  'B11 (Session 97) — Primary PDF text source selection. When enabled=true, the OCR dispatcher (src/lib/ocr/index.ts) attempts pdfjs text-layer extraction first for PDF uploads. Byte-exact from PDF native text layer + free + ~25x faster than Document AI OCR for digital PDFs. Naturally column-aware (pdfjs emits in PDF content stream order which IS the document author''s reading order for federal SBCs — no reflow applied to this path). Falls back to Document AI on ImageOnlyPDFError (text density below 500 chars) or any pdfjs failure (encrypted PDFs, malformed structure, etc.) — degraded-but-extracted output preferred over hard failure. Default disabled; legacy Document AI raw-text path stays live until admin flips. Independent of ocr_reflow_v1 (which gates reflow on the Document AI fallback path only).',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'ocr_reflow_v1',
  false,
  'B11 (Session 97) — Column-aware reading-order reflow for Document AI OCR output. When enabled=true, the OCR dispatcher applies the universal column-detect + reflow primitive (src/lib/ocr/reflow.ts) to Document AI OCR blocks before returning the result. Closes the column-interleaving artifact on multi-column SBC layouts (BS-class fixtures lifted from 23 services → target 38+ at parity with Ambetter). Required for image-only PDFs that bypass the pdfjs path. Cite-grade safe by construction — each block''s text is byte-exact; only concatenation order changes. Default disabled; legacy Document AI raw document.text path stays live until admin flips. Independent of pdfjs_primary_v1.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
