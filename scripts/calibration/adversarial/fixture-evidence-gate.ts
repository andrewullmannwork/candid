// Ing-G.2/3 — S172 fix-now regression fixture (Ship Gate G4).
//
// The corpus (score-corpus.ts) validates the detection-vs-FP CURVE but has ZERO
// non-SBC plan documents — which is exactly why Finding C was invisible to it.
// This fixture asserts the behaviors the corpus CANNOT show:
//   • the plan-doc fix: a non-SBC plan_document is not structurally penalized,
//   • gate B closes the mention-FP: a doc that only mentions the SBC phrase,
//   • the structural signal still fires for docs that present as SBCs,
//   • the artifact (font) path is intact independent of the gate,
//   • ingest scope (resolveEffectiveDocType) admits plan-class, skips bills/EOB/cards,
//   • idempotency preserves human review + re-scores unreviewed on a ruleset bump.
//
//   npx tsx scripts/calibration/adversarial/fixture-evidence-gate.ts

import { scoreAdversarialPdf, DEFAULT_ADVERSARIAL_CONFIG } from "@/lib/parser/adversarial-pdf";
import type { AdversarialPdfFeatures } from "@/lib/parser/adversarial-pdf-features";
import { resolveEffectiveDocType, type DocTypePick } from "@/lib/documents/effective-doc-type";
import { shouldSkipReassessment, ADVERSARIAL_RULESET_VERSION } from "@/lib/parser/adversarial-pdf-ingest";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
}

// A real, font-rich, fully-structured SBC. Overrides build each case.
const realSbc = (): AdversarialPdfFeatures => ({
  producer: "Adobe PDF Library", creator: "Adobe InDesign",
  pages: 8, file_size: 500_000, encrypted: false,
  n_fonts: 12, n_embedded: 12, n_subset: 12, n_images: 2,
  text_len: 8000, has_text_layer: true, image_only: false,
  sbc_header: true, has_important_questions: true, has_why_this_matters: true,
  has_coverage_examples: true, omb_present: true, omb_correct: true,
  structure_ok: true, text_ok: true,
});
const score = (f: AdversarialPdfFeatures) => scoreAdversarialPdf(f, DEFAULT_ADVERSARIAL_CONFIG);
const hasStructural = (f: AdversarialPdfFeatures) =>
  score(f).reasons.some((r) => r.code === "missing_template_markers");
const isPlanClass = (t: string) => t === "sbc" || t === "plan_document" || t === "eoc";

console.log("Scorer — evidence-gated structural (gate B):");

// 1. Real SBC → clean (no structural penalty, not flagged).
{
  const a = score(realSbc());
  check("real SBC: not flagged + no structural reason", !a.flagged && !hasStructural(realSbc()));
}

// 2. THE PLAN-DOC FIX (Finding C): a non-SBC plan_document (no header, no markers,
//    but font-rich like a real EOC) is NOT structurally penalized.
{
  const f = { ...realSbc(), sbc_header: false, has_important_questions: false,
    has_why_this_matters: false, has_coverage_examples: false, omb_present: false, omb_correct: false };
  const a = score(f);
  check("non-SBC plan_document: score 0, not flagged (was 0.45 under the old code)", a.score === 0 && !a.flagged);
  check("non-SBC plan_document: no structural reason", !hasStructural(f));
}

// 3. Gate B closes the mention-FP: header phrase present but NO other SBC marker
//    (a plan doc that merely references its SBC) → not treated as an SBC.
{
  const f = { ...realSbc(), sbc_header: true, has_important_questions: false,
    has_why_this_matters: false, has_coverage_examples: false, omb_present: false, omb_correct: false };
  const a = score(f);
  check("mention-only (header, no marker): not flagged (gate A would flag 0.30)", !a.flagged && !hasStructural(f));
}

// 4. Structural signal STILL fires for docs that present as SBCs: header + OMB,
//    missing Important-Questions + Why-This-Matters → penalized + flagged.
{
  const f = { ...realSbc(), has_important_questions: false, has_why_this_matters: false, omb_present: true };
  const a = score(f);
  check("partial fake (header+OMB, missing IQ+WTM): flagged + structural reason", a.flagged && hasStructural(f));
}
// 4b. Single missing marker fires the signal (even if below τ alone).
{
  const f = { ...realSbc(), has_why_this_matters: false };
  check("partial fake (missing WTM only): structural signal present", hasStructural(f));
}

// 5. Artifact path intact independent of the gate: sparse-font header-less synthetic.
{
  const f = { ...realSbc(), sbc_header: false, has_important_questions: false, has_why_this_matters: false,
    omb_present: false, omb_correct: false, n_fonts: 1, n_subset: 0, n_embedded: 0, pages: 1, producer: "Skia/PDF" };
  check("sparse-font header-less synthetic: flagged via font/thin/producer", score(f).flagged);
}

console.log("\nIngest scope — resolveEffectiveDocType (Finding D):");
const eff = (pick: DocTypePick, classified: string, conf: number, pages: number) =>
  resolveEffectiveDocType(pick, classified, conf, pages).effectiveDocType;
check("SBC → plan-class (assess)", isPlanClass(eff("sbc", "sbc", 0.9, 6)));
check("plan_document → plan-class (assess)", isPlanClass(eff("plan_document", "plan_document", 0.9, 40)));
check("EOC (classifier override) → plan-class (assess)", isPlanClass(eff("plan_document", "eoc", 0.9, 120)));
check("itemized_bill → NOT plan-class (skip)", !isPlanClass(eff("itemized_bill", "itemized_bill", 0.9, 3)));
check("eob → NOT plan-class (skip)", !isPlanClass(eff("eob", "eob", 0.9, 2)));
check("user-said-bill but classifier high-conf plan_document → plan-class (assess)", isPlanClass(eff("itemized_bill", "plan_document", 0.95, 8)));

console.log("\nIdempotency — shouldSkipReassessment (review-preserving + ruleset-aware):");
const R = ADVERSARIAL_RULESET_VERSION;
check("no prior → assess", shouldSkipReassessment(undefined, R) === false);
check("prior Confirmed → skip (human decision final)", shouldSkipReassessment({ review_state: "confirmed", ruleset_version: "g23-v1" }, R) === true);
check("prior Cleared → skip (human decision final)", shouldSkipReassessment({ review_state: "cleared", ruleset_version: "g23-v1" }, R) === true);
check("prior unreviewed @ OLD ruleset → re-assess", shouldSkipReassessment({ review_state: "unreviewed", ruleset_version: "g23-v1" }, R) === false);
check("prior unreviewed @ SAME ruleset → skip (idempotent)", shouldSkipReassessment({ review_state: "unreviewed", ruleset_version: R }, R) === true);

console.log(`\n${pass}/${pass + fail} assertions passed.`);
if (fail > 0) { console.error(`${fail} FAILED`); process.exit(1); }
