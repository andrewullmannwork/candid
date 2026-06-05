# Ing-G.2a — Adversarial-Upload Detection Corpus (rubric + findings)

**Built:** S169 (2026-06-05). **Gates:** Ing-G.2b (anti-AI-PDF heuristic) + Ing-G.3 (structural validation).
**Posture (LOCKED):** SCORE + admin-queue, **never auto-reject** at MVP.

This corpus is the ground truth for the artifact-level (G.2b) and structural (G.3) adversarial-upload
detectors. It is a **calibration set**, not validated PROD performance (there is no live traffic at
~0 users) — see *Representativeness caveats*.

## Composition (119 PDFs)

| Stratum | N | What it is |
|---|---|---|
| **real** | 69 | Diversity-stratified sample of cold-start SBC PDFs (PROD `documents`, `classified_type='plan_document'`), via `insurance_plans.source_document_id`. 51 insurers / 18 states / 3 plan-years. **63 born-digital + 6 rasterized scanned-sim** (image-only, no text layer — the legit-but-degraded tail for G.3 FP). Artifacts confirmed present in the `documents` bucket. |
| **synthetic** | 40 | Forged SBCs across two axes (below): HTML→{Chrome/Skia 10, macOS-Quartz 10} + programmatic pdf-lib 20. |
| **modified_real** | 10 | Real SBC + a tampered cost-share value. G.2b **blind-spot measurement** (real fonts/structure, fake values). 5 re-saved (producer→pypdf) + 5 producer-**spoofed** (claims the original insurer producer; verified to preserve the original embedded fonts exactly). |

### Synthetic axes (the artifact detector keys on Axis B, not Axis A)
- **Axis A — content source:** `chatgpt` (4), `gemini` (3), `claude` (3) HTML + `claude-programmatic` (20). Anti single-*model*-artifact.
- **Axis B — render pipeline (3 producers):** `chrome-headless` (`Skia/PDF`) + `macos-quartz` (`Quartz PDFContext`, native, text-only) + `pdf-lib` (`pdf-lib`). Anti single-*renderer*-artifact. **This is the axis G.2b actually fingerprints.**
- **Fidelity gradient:** `naive` (no federal structure / no OMB) → `moderate` → `high` (full 5-page federal template, OMB footer). Drives the G.3 structural signal.

## Label rubric (per `manifest.json` entry)
- `stratum` ∈ {real, synthetic, modified_real} — the supervised label (real = negative; synthetic/modified_real = positive).
- Artifact features: `producer`, `creator`, `pages`, `file_size`, `n_fonts`, `n_embedded`, `n_subset`, `n_images`, `has_text_layer`, `image_only_scanned`.
- Structural (G.3) features: `sbc_header`, `has_important_questions`, `has_why_this_matters`, `has_coverage_examples`, `omb_present`, `omb_value`, `omb_correct`.
- Provenance: `axis_a_content`, `axis_b_renderer`, `fidelity`, `variant` (modified_real), `producer_expected`; real: `insurer`, `state`, `year`, `plan_type`.

## 🔴 Headline finding — producer is NOT a separable signal for SBCs

Real insurers produce SBCs with a **heterogeneous, adversary-accessible toolchain**:

| Real-SBC producer family | N (of 60) |
|---|---|
| **pypdf / PyPDF2** | 13 |
| aspose | 11 · microsoft word 8 · adobe pdf library 5 · xpression 4 · adobe acrobat 4 · abcpdf 4 |
| ghostscript 2 · pdflib 2 · **pdf-lib 1** · **skia 1** · itext 1 · fja 1 · (none) 3 | |

**`PRODUCER_FAMILY_OVERLAP` = {adobe pdf library, aspose, pdf-lib, pypdf, skia} → 33/69 (48%) of real SBCs
share a producer family with an adversarial doc** (synthetic or modified_real). Note `Quartz PDFContext`
(the macOS-Quartz synthetics' producer) *also* appears on real macOS-printed uploads — another collision.

**Implication for G.2b (overturns the plan's implicit assumption):**
- A producer-allowlist detector would **false-positive on ~52% of real SBCs** OR **miss the adversarial classes that reuse those families** (pypdf-resaved modified-reals blend into the 13 PyPDF2 reals; pdf-lib/Skia synthetics each collide with a real).
- ⇒ **Producer must be at most a weak, non-dispositive feature.** G.2b must be a **multi-feature transparent reason-code scorer** (font-subset uniformity + text-vs-raster + object-stream regularity + structural plausibility), and the **primary defense weight shifts to G.3 (structural) + CF-40 corroboration + value-plausibility**, not artifact provenance.
- This vindicates the S169 Q2 "causal-not-incidental features" + Q4 "measurement-validity" refinements — and is exactly the kind of assumption a calibration corpus exists to falsify *before* code is built on it.

## Other findings
- **SBC-header confirm:** real 60/60, synthetic 28/30 (the 2 `naive` synthetics correctly **omit** the federal header → the structural signal G.3 keys on), modified_real 10/10.
- **9/30 synthetics carry the *correct* OMB `0938-1146`** → an OMB-presence/format check is evadable; OMB is a weak structural feature, not a gate.
- **Structural completeness** (`important questions` + `why this matters`) cleanly separates `high`-fidelity synthetics from `naive`/`moderate` — G.3's strongest lever.

## Representativeness caveats — closure status (S169)
1. **HTML renderer diversity — ✅ CLOSED to 3 producers.** `Skia/PDF` (Chrome) + `Quartz PDFContext` (macOS-Quartz, native) + `pdf-lib` (programmatic), plus the 6 rasterized reals (image/raster class). *Residual:* no *faithful CSS-rendering* 2nd engine (weasyprint/wkhtmltopdf/LibreOffice need a `brew install` of pango/cairo or the LO cask; cairo/pango are absent). The macOS-Quartz path is text-only. Given the producer-not-separable finding this residual is minor — a `brew install weasyprint` would add a 4th producer + a faithful table render if desired; tracked as an optional expansion.
2. **Scanned tail — ✅ CLOSED (simulated).** 6 reals rasterized @150 DPI → image-only, no text layer (`provenance='rasterized-scan-sim'`). G.3 FP on degraded reals is now measurable. *Residual:* simulated rasterization, not true scanner artifacts (no skew/noise/scanner-driver producer); 0 true scans exist in cold-start (exchange downloads are born-digital). Source real scans post-launch if available.
3. **Template-year — ✅ CLOSED (+ reframed).** Real years now 2026 (66) / 2024 (2) / 2025 (1). *Important reframe:* 2024–2026 SBCs are the **same federal template revision** (OMB `0938-1146`, stable since ~2017), so the current production template is well-covered; a *future* template revision is a **recalibration trigger**, not a present corpus gap. (Pre-2017-revision SBCs are unavailable — exchanges host only current plans.)
4. **modified_real artifact realism — ✅ CLOSED (verified).** Spoofed variants preserve the **original embedded fonts exactly** (identical subset tags, e.g. `BCDEEE+ArialNarrow`) + the original producer string + original page content; only object IDs are renumbered + a tampered overlay added. The artifact reads as real. *Residual:* pypdf object-renumbering (vs a true Acrobat incremental-xref append) + the tamper is an overlay annotation, not a content-stream edit — the rarest surgical-edit case, requiring Acrobat/qpdf not present locally.
5. **No live traffic — ❌ INHERENT (not a corpus gap).** ~0 users ⇒ no traffic exists pre-launch; this cannot be closed by adding to the corpus. Closure mechanism = the G.2b/G.7 **post-launch obligation**: always-on shadow scoring + fire/non-fire telemetry reconciled against this corpus at the first N real uploads. The corpus is correctly a calibration estimate until then.

## Regenerate
```
npx tsx  scripts/calibration/adversarial/build-real-set.ts --introspect --target 63   # stratify, force non-2026 (no download)
npx tsx  scripts/calibration/adversarial/build-real-set.ts --download                  # pull real PDFs (local-only, skip-existing)
python3  scripts/calibration/adversarial/gen-scanned-sim.py 6                           # rasterize 6 reals → image-only scanned tail
npx tsx  scripts/calibration/adversarial/render-synthetics.ts                          # HTML → Chrome/Skia + macOS-Quartz
npx tsx  scripts/calibration/adversarial/gen-programmatic.ts --count 20                 # pdf-lib programmatic
python3  scripts/calibration/adversarial/gen-modified-real.py 5                         # modified-real (×2 variants)
python3  scripts/calibration/adversarial/extract-features.py                            # → manifest.json + corpus-summary.json
```
Raw PDFs + HTML-derived PDFs are **local-only (gitignored)**; committed artifacts = synthetic HTML inputs,
`manifest.json`, `corpus-summary.json`, `rubric.md`, and the builder scripts. PII discipline: real PDFs are
PROD-sourced and never leave the local checkout; only aggregate/feature data is committed.

## Ship-Gate evidence this corpus provides (for G.2b/G.3 PRs)
- **G2 (positive-path):** detection-rate on synthetic + FP on real, **as a curve across thresholds** (not one operating point) — pre-declare pass thresholds + fail conditions.
- **G3 (PROD-corpus):** the 69-doc real set IS the FP measurement base (63 born-digital + 6 scanned-sim).
- **G4 (fixture):** `manifest.json` feature vectors are the committable CI fixture (raw PDFs not required).
- **G7 (telemetry):** always-on shadow scoring + fire/non-fire on every real upload; reconcile vs this corpus at first N uploads.
