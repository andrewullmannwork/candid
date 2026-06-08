// Ing-G.2/3 — Adversarial-PDF scorer (transparent additive reason-code fusion).
//
// Fuses artifact + structural signals into one explainable score. NO fitted
// model (N≈120 + the producer-not-separable finding make any fit an overfit);
// weights are hand-set and flag-config-tunable (Ship Gate G6). Each contributing
// feature emits a human-readable reason code for the admin queue.
//
// Why fusion (one score) and not two thresholded blocks: weak, complementary
// signals. Structural completeness catches naive/moderate forgeries; the font
// profile catches the structurally-complete-but-sparse ones; neither alone draws
// the right boundary, and cross-corroboration cancels false positives a single
// signal can't (e.g. a real SBC whose text extraction failed reads as
// "missing markers" but its real-like font profile keeps it un-flagged).
//
// Honest scope: catches naive/moderate synthetics; HIGH-fidelity full-artifact
// synthetics + modified-real value-tampers are residuals handed to CF-40 v4
// corroboration + value-plausibility (a single cold-start plausible tamper is a
// fundamental residual no artifact/structural detector can close). Producer is a
// capped, never-dispositive weak feature (33/69 real SBCs share an adversarial
// producer family — see project_candid_g2b_producer_not_separable).

import type { AdversarialPdfFeatures } from "./adversarial-pdf-features";

export type AdversarialReasonCode =
  | "missing_template_markers" // structural group — federal SBC markers absent
  | "sparse_fonts" // artifact — too few embedded fonts for a real SBC
  | "low_subset_ratio" // artifact — fonts not subset-embedded (web/base-14 signature)
  | "thin_document" // artifact (weak) — too few pages
  | "synthetic_leaning_producer" // artifact (weak, capped) — producer family leans synthetic
  | "image_only_unassessable" // branch — scanned/raster, no text layer
  | "structure_unparseable"; // branch — neither structure nor text could be read

export interface AdversarialReason {
  code: AdversarialReasonCode;
  weight: number; // this feature's contribution to the score
  detail: string;
}

export interface AdversarialPdfConfig {
  /** behavior WHEN the flag is enabled. Today ADVISORY ONLY — nothing branches on
   *  this; the admin work-list surfaces flagged docs in any mode (shadow rows are
   *  shown for FP measurement). `enforce` will mean "quarantine the flagged doc's
   *  flywheel contribution" once ID-Block ships (S171 Finding A). (The OFF state is
   *  the flag's `enabled=false` — byte-identical — not a config mode.) */
  mode: "shadow" | "enforce";
  /** flag if score ≥ threshold (and assessable) */
  threshold: number;
  /** additive weights — sum to 1.0 so score ∈ [0,1]. structural primary; producer capped weak. */
  weights: { structural: number; fonts: number; thin: number; producer: number };
  /** n_fonts ≤ this drives the sparse-font signal toward 1 */
  sparseFontMax: number;
  /** pages ≤ this trips the (weak) thin-document signal */
  thinPageMax: number;
  /** require this much extracted text before trusting marker-ABSENCE (FP guard) */
  minTextForStructural: number;
  /** producer families that lean synthetic (weak; many appear on reals too) */
  syntheticProducers: string[];
}

export const DEFAULT_ADVERSARIAL_CONFIG: AdversarialPdfConfig = {
  // shadow + τ=0.20 = the S170 corpus-validated operating point (88% synthetic
  // detection / 8% real FP). Safe default the moment the flag is enabled:
  // measure-only until config.mode is set to "enforce". All tunable (G6).
  mode: "shadow",
  threshold: 0.2,
  weights: { structural: 0.45, fonts: 0.3, thin: 0.13, producer: 0.12 },
  sparseFontMax: 5,
  thinPageMax: 2,
  minTextForStructural: 500,
  syntheticProducers: ["pdf-lib", "skia", "quartz"],
};

/** Pure merge of a (partial) flag-config override onto the code defaults.
 *  Mirrors the loadCF40V4Config pattern; the DB read lives in the wiring layer. */
export function resolveAdversarialConfig(
  override?: Partial<AdversarialPdfConfig> | null,
): AdversarialPdfConfig {
  if (!override) return DEFAULT_ADVERSARIAL_CONFIG;
  return {
    ...DEFAULT_ADVERSARIAL_CONFIG,
    ...override,
    weights: { ...DEFAULT_ADVERSARIAL_CONFIG.weights, ...(override.weights ?? {}) },
  };
}

/** Normalize a producer string to a tool family (matches the corpus analysis). */
function producerFamily(producer: string): string {
  const p = (producer || "").toLowerCase();
  for (const fam of ["pdf-lib", "skia", "quartz", "pypdf", "aspose", "adobe", "microsoft", "word", "itext", "ghostscript"]) {
    if (p.includes(fam)) return fam === "word" ? "microsoft" : fam;
  }
  return p ? "other" : "(none)";
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export interface AdversarialAssessment {
  score: number; // [0,1]
  flagged: boolean; // assessable ∧ score ≥ threshold
  assessable: boolean; // false → couldn't assess (scanned / unparseable); never a positive
  reasons: AdversarialReason[];
}

/**
 * Score a feature vector. Pure + deterministic + purely feature-driven (no
 * doc-type input — scope lives at the ingest layer). Returns `flagged`; what
 * happens to a flagged doc (admin work-list today; flywheel quarantine once
 * ID-Block ships) is the caller's concern.
 */
export function scoreAdversarialPdf(
  f: AdversarialPdfFeatures,
  config: AdversarialPdfConfig = DEFAULT_ADVERSARIAL_CONFIG,
): AdversarialAssessment {
  // ── Branch: scanned / image-only → unassessable (protects real scans from FP;
  //    a raster adversary is handed to CF-40 + value-plausibility downstream). ──
  if (f.image_only) {
    return {
      score: 0, flagged: false, assessable: false,
      reasons: [{ code: "image_only_unassessable", weight: 0, detail: "no text layer (scanned/raster); artifact + structural signals inapplicable" }],
    };
  }
  // ── Branch: neither structure nor text could be read → neutral, never a positive. ──
  if (!f.structure_ok && !f.text_ok) {
    return {
      score: 0, flagged: false, assessable: false,
      reasons: [{ code: "structure_unparseable", weight: 0, detail: "PDF object graph and text layer both unreadable" }],
    };
  }

  const w = config.weights;
  const reasons: AdversarialReason[] = [];
  let score = 0;

  // ── Structural group (PRIMARY) — federal SBC template completeness. Gated on
  //    POSITIVE SBC evidence (S171 Finding C): the header phrase PLUS ≥1 other
  //    federal marker (Important Questions / Why This Matters / OMB number).
  //    Trusting classified_type='plan_document' (2471 of 2573 PROD docs — the
  //    dominant plan-class bucket, ~9% of them non-SBC) — OR the header phrase
  //    alone, which matches a mere mention anywhere in the text — false-flagged
  //    real non-SBC docs at ~0.45 (measured: 4/45 sampled spared, 0 regressions).
  //    Requiring
  //    a corroborating marker means only docs that actually present as SBCs are
  //    judged for template completeness. Also gated on readable text so an
  //    unreadable doc isn't penalized for "missing" markers (the key FP guard). ──
  const sbcContext =
    f.sbc_header && (f.has_important_questions || f.has_why_this_matters || f.omb_present);
  const textReadable = f.text_ok && f.text_len >= config.minTextForStructural;
  if (sbcContext && textReadable) {
    // header is the gate (guaranteed present here); score the remaining template
    // sections. /3 retained so the structural scale matches the S170 corpus
    // calibration that fixes the τ=0.20 operating point.
    const missing: string[] = [];
    if (!f.has_important_questions) missing.push("important_questions");
    if (!f.has_why_this_matters) missing.push("why_this_matters");
    if (missing.length > 0) {
      const c = w.structural * (missing.length / 3);
      score += c;
      reasons.push({ code: "missing_template_markers", weight: c, detail: `federal SBC markers absent: ${missing.join(", ")}` });
    }
  }

  // ── Font profile (artifact, MODERATE) — only when the object graph parsed.
  //    Real enterprise SBCs carry many subset-embedded fonts; synthetics are
  //    sparse (few fonts) or non-subset (web/base-14). max() of the two signals. ──
  if (f.structure_ok) {
    const sparse = clamp01((config.sparseFontMax - f.n_fonts) / config.sparseFontMax);
    const subsetRatio = f.n_fonts > 0 ? f.n_subset / f.n_fonts : 0;
    const lowSubset = f.n_fonts > 0 ? clamp01(1 - subsetRatio) : 0;
    const fontActivation = Math.max(sparse, lowSubset);
    if (fontActivation > 0) {
      const c = w.fonts * fontActivation;
      score += c;
      reasons.push({
        code: sparse >= lowSubset ? "sparse_fonts" : "low_subset_ratio",
        weight: c,
        detail: `n_fonts=${f.n_fonts}, subset=${f.n_subset} (ratio ${subsetRatio.toFixed(2)})`,
      });
    }
  }

  // ── Thin document (artifact, WEAK/capped — overfit guard; a full-length
  //    forgery evades, so this is never dispositive). ──
  if (f.structure_ok && f.pages > 0 && f.pages <= config.thinPageMax) {
    const c = w.thin;
    score += c;
    reasons.push({ code: "thin_document", weight: c, detail: `${f.pages} page(s)` });
  }

  // ── Producer family (artifact, WEAK/capped — DEMOTED per the finding; real
  //    SBCs share these families, so it can never alone cross threshold). ──
  const fam = producerFamily(f.producer);
  if (config.syntheticProducers.includes(fam)) {
    const c = w.producer;
    score += c;
    reasons.push({ code: "synthetic_leaning_producer", weight: c, detail: `producer family: ${fam}` });
  }

  score = clamp01(score);
  return { score, flagged: score >= config.threshold, assessable: true, reasons };
}
