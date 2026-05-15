/**
 * Plan-doc layout detector — Stage A of the layout-aware 2-stage extraction
 * architecture (Pattern P-9: Parse Quality Flywheel — see Candid_Parse_Patterns.md).
 *
 * Pure-regex pre-classification. Federal SBCs are 100% identifiable by their
 * federally-mandated headings ("Important Questions", "Common Medical Events",
 * "Why This Matters", "Excluded Services & Other Covered Services", "Coverage
 * Examples"). EOCs, employer booklets, and plan certificates have softer
 * signatures but are still distinguishable from federal SBCs in the dominant
 * cases.
 *
 * The detected layout is passed to Stage B extraction prompts so they can
 * conditionally include layout-specific instructions / few-shots (e.g.,
 * federal-SBC layouts need the "pdftotext splits table cells across lines —
 * quote SINGLE LINES; do NOT reconstruct multi-line rows" rule that the
 * existing SBC parser already uses).
 *
 * S92 (Session 92) — initial implementation. Future sessions can promote any
 * label to Haiku-based detection if regex precision drops below a target.
 */

export type PlanDocLayout =
  | "federal_sbc_8page" // federal SBC template (5 sections + 8-page regulatory standard)
  | "federal_sbc_csr_variant" // federal SBC with CSR enhancement (Silver 73 / 87 / 94)
  | "full_eoc_narrative" // long-form EOC narrative document
  | "employer_plan_booklet" // employer-published plan summary / benefits booklet
  | "plan_cert_summary" // plan certificate, schedule of benefits, or SOB
  | "unknown";

export interface LayoutDetectionResult {
  layout: PlanDocLayout;
  confidence: number; // 0-1; how strongly the input matches the chosen layout
  features: string[]; // diagnostic feature flags that drove the decision
}

/**
 * Detect the structural layout of a plan-doc OCR text. Pure-regex; no I/O.
 * Caller passes already-cleaned text (post subtractive-cleanup).
 */
export function detectLayout(text: string): LayoutDetectionResult {
  const features: string[] = [];

  // ── Federal-SBC signature: 5 federally-mandated headings ─────────────────
  const hasImportantQuestions = /Important\s+Questions/i.test(text);
  const hasCommonMedicalEvents = /Common\s+Medical\s+Events/i.test(text);
  const hasWhyThisMatters = /Why\s+This\s+Matters/i.test(text);
  const hasExcludedServices = /Excluded\s+Services\s*(&|and)\s+Other\s+Covered\s+Services/i.test(text);
  const hasCoverageExamples = /Coverage\s+Examples/i.test(text);

  if (hasImportantQuestions) features.push("important_questions_heading");
  if (hasCommonMedicalEvents) features.push("common_medical_events_heading");
  if (hasWhyThisMatters) features.push("why_this_matters_column");
  if (hasExcludedServices) features.push("excluded_services_heading");
  if (hasCoverageExamples) features.push("coverage_examples_heading");

  const sbcHeadingCount = [
    hasImportantQuestions,
    hasCommonMedicalEvents,
    hasWhyThisMatters,
    hasExcludedServices,
    hasCoverageExamples,
  ].filter(Boolean).length;

  // CSR-variant detection (CSR-enhanced Silver plans have specific signals)
  const isCsrVariant =
    /\bCSR\b|cost[-\s]share\s+reduction|Silver\s+(73|87|94)/i.test(text);

  if (sbcHeadingCount >= 4) {
    // Strong federal-SBC signature: 4+ of 5 standardized headings present
    if (isCsrVariant) features.push("csr_variant_signal");
    return {
      layout: isCsrVariant ? "federal_sbc_csr_variant" : "federal_sbc_8page",
      confidence: 0.95,
      features,
    };
  }

  if (sbcHeadingCount >= 2) {
    // Plausible federal SBC inside a bundled PDF (e.g., SBC + EOC stacked)
    if (isCsrVariant) features.push("csr_variant_signal");
    return {
      layout: isCsrVariant ? "federal_sbc_csr_variant" : "federal_sbc_8page",
      confidence: 0.7,
      features,
    };
  }

  // ── EOC narrative signature: long prose + plan-promise verbiage ──────────
  // EOCs are 50-200 page narrative documents with characteristic phrasing.
  const eocPhrases = (text.match(/your\s+plan|we\s+will\s+(pay|cover)|covered\s+services|the\s+plan\s+(will\s+pay|covers)/gi) || []).length;
  if (eocPhrases > 30) {
    features.push(`eoc_narrative_phrases:${eocPhrases}`);
    return { layout: "full_eoc_narrative", confidence: 0.8, features };
  }

  // ── Employer plan booklet signature: HR-style phrasing ────────────────────
  const isEmployerBooklet =
    /\bPlan\s+Sponsor\b|\bBenefits\s+Summary\b|\bEmployee\s+Benefits\b|\bThis\s+Booklet\b|\bSummary\s+Plan\s+Description\b/i.test(text);
  if (isEmployerBooklet) {
    features.push("employer_booklet_signal");
    return { layout: "employer_plan_booklet", confidence: 0.6, features };
  }

  // ── Plan certificate / Schedule of Benefits ──────────────────────────────
  const isPlanCert =
    /\bPlan\s+Certificate\b|\bSchedule\s+of\s+Benefits\b|\bCertificate\s+of\s+Coverage\b/i.test(text);
  if (isPlanCert) {
    features.push("plan_cert_signal");
    return { layout: "plan_cert_summary", confidence: 0.6, features };
  }

  // ── Unknown — fall through to default plan-doc extraction logic ──────────
  return { layout: "unknown", confidence: 0.5, features };
}
