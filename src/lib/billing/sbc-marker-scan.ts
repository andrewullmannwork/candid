// S94 B4 — SBC marker scan.
//
// Pure function. Scans OCR text for fingerprints of a Summary of Benefits
// and Coverage (SBC) document and reports a likely-SBC verdict when at
// least `minMarkers` distinct markers match.
//
// Motivating incident (S94 B1 Stage 4 testing 2026-05-15): user uploaded
// an SBC as "Bill" via the document picker. Haiku bill parser hallucinated
// 5 line items with fake CPT codes (10348, 21244, 20201, 51330) extracted
// from P.O. Box numbers, ZIP codes, and phone numbers — and reported $93k
// patient responsibility from coverage-example math. This scan refuses to
// invoke the bill parser when the input is structurally an SBC.
//
// Doc-type resolver hardening (s94-b5) addresses misrouting at the
// classifier; this scan is parser-side defense-in-depth for the case where
// the resolver fails or is bypassed.
//
// Markers chosen for high specificity to ACA-standardized SBC layout
// (Common Medical Event table headers, coverage example section header,
// Important Questions table header). Federal SBC template hasn't shifted
// these phrasings since 2010. Requires ≥2 matches to fire — single-marker
// hits could occur on real bills that incidentally mention "Summary of
// Benefits" in passing.

const SBC_MARKERS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "title", pattern: /Summary of Benefits and Coverage/i },
  { name: "subtitle", pattern: /What this Plan Covers[\s\S]{0,80}What You Pay/i },
  { name: "common_medical_event", pattern: /Common Medical Event/i },
  { name: "services_you_may_need", pattern: /Services You May Need/i },
  { name: "limitations_exceptions", pattern: /Limitations,?\s+Exceptions\s+&\s+Other Important Information/i },
  { name: "coverage_examples_header", pattern: /About these Coverage Examples/i },
  { name: "not_a_cost_estimator", pattern: /This is not a cost estimator/i },
  { name: "coverage_for_plan_type", pattern: /Coverage for:[\s\S]{0,160}Plan Type:/i },
  { name: "deductible_question", pattern: /Are there services covered before you meet your deductible/i },
  { name: "out_of_pocket_question", pattern: /What is the out[\s-]?of[\s-]?pocket limit for this/i },
  { name: "minimum_essential_coverage", pattern: /Does this plan provide Minimum Essential Coverage/i },
] as const;

export interface SbcScanResult {
  isLikelySbc: boolean;
  matchedMarkers: string[];
  totalMarkersChecked: number;
}

export function scanForSbcMarkers(ocrText: string, minMarkers = 2): SbcScanResult {
  const matched: string[] = [];
  for (const { name, pattern } of SBC_MARKERS) {
    if (pattern.test(ocrText)) matched.push(name);
  }
  return {
    isLikelySbc: matched.length >= minMarkers,
    matchedMarkers: matched,
    totalMarkersChecked: SBC_MARKERS.length,
  };
}
