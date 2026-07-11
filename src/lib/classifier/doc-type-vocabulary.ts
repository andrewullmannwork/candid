/**
 * src/lib/classifier/doc-type-vocabulary.ts — shared doc-type vocabulary +
 * equivalence-class mapping.
 *
 * Lives in its own module (not inline in `fallback.ts`) because:
 *   1. PICKER_TYPES must stay synchronized with the 2-card upload picker in
 *      `src/app/(app)/upload/page.tsx`. Co-locating the canonical set with the
 *      classifier equivalence logic makes that contract visible from one place.
 *   2. Frontend code can import PICKER_TYPES if it ever wants a runtime guard
 *      that the picker state matches the backend's set of valid options.
 *   3. Backend halt logic (`shouldHaltForUserConfirmation`) and sanity gate
 *      logic (`applyBillParserSanityGate`) both depend on this vocabulary.
 *
 * If you add a new upload-picker card option (e.g., a card-scan card), update
 * PICKER_TYPES here AND the picker UI's `docType` state type to match.
 */

/**
 * Doc-type subtypes the 2-card upload picker can emit. Source of truth for the
 * frontend → backend doc-type vocabulary contract.
 *
 * "Bill" card emits: 'eob' OR 'itemized_bill'
 * "Plan Document" card emits: 'sbc' OR 'plan_document'
 *
 * NOTE: even though the Haiku classifier can output 'eoc', 'employer_plan_booklet',
 * 'plan_cert_summary', and 'insurance_card', the picker never emits those — they
 * are NOT in PICKER_TYPES. The confirmation modal renders option buttons keyed
 * to PICKER_TYPES; offering "eoc" as a modal option would either render with no
 * DOC_TYPES entry (broken) or require expanding the picker UI.
 */
export const PICKER_TYPES = new Set([
  "sbc",
  "plan_document",
  "eob",
  "itemized_bill",
]);

/**
 * Type alias for the 4 picker doc-types (the wire vocabulary `documents.doc_type`
 * holds one of these). Distinct from ClassifierDocType which adds the classifier-
 * specific `eoc` subtype.
 */
export type DocType = "eob" | "itemized_bill" | "sbc" | "plan_document";

/**
 * Classifier output may include `eoc` as a sub-type even though it's not in
 * the picker vocabulary — the resolver routes it to `plan_document` for storage.
 */
export type ClassifierDocType = DocType | "eoc";

/**
 * Server-emitted payload when a doc-type classification disagreement halts the
 * pipeline for user confirmation (S94 B5). Frontend renders the confirmation
 * modal with this data; user picks one option from `options`; pipeline resumes.
 */
export interface DocTypeConfirmation {
  user_pick: DocType;
  classifier_pick: ClassifierDocType;
  classifier_confidence: number;
  page_count: number;
  /** Subset of DocType values the user can pick from in the modal. */
  options: DocType[];
}

/**
 * Doc-type equivalence classes used to decide whether a classifier disagreement
 * with the user pick is materially user-actionable. See `shouldHaltForUserConfirmation`
 * in `fallback.ts` for the usage rationale.
 */
export type DocTypeClass = "bill" | "plan_doc" | "card" | "other";

export function getDocTypeClass(type: string | null | undefined): DocTypeClass {
  if (type === "eob" || type === "itemized_bill") return "bill";
  if (
    type === "sbc" ||
    type === "plan_document" ||
    type === "eoc" ||
    type === "employer_plan_booklet" ||
    type === "plan_cert_summary"
  ) {
    return "plan_doc";
  }
  if (type === "insurance_card") return "card";
  return "other";
}

// ─── Doc-type rendering metadata ────────────────────────────────────────────
//
// 2-card upload picker presentation + per-wire-type label/description/tips.
// Kept here so the doc-type contract has ONE source of truth: vocabulary +
// equivalence + rendering metadata. Consumed by:
//   - src/app/(app)/upload/page.tsx (2-card picker + "Your uploaded documents"
//     list status pills + S94 B5 doc-type-confirmation modal options)
//   - src/components/parsing/DocTypeConfirmationModal.tsx (S100 — renders
//     option buttons from `options` array via DOC_TYPES[opt]).
//
// Adding a new doc-type: add a wire-type entry to DOC_TYPES + decide whether
// to expose it via PICKER_OPTIONS (a card the user can pick) + update
// PICKER_TYPES set above + update getDocTypeClass() equivalence.

export const PICKER_OPTIONS = {
  bill: {
    label: "Bill",
    short: "Bill",
    description: "An EOB or itemized bill from your insurer or provider",
    selectsAs: "eob" as const,
    tips: [
      "An EOB (Explanation of Benefits) is what your insurer mails or emails after a claim is processed",
      "An itemized bill is from your provider — request one if you only got a summary statement (providers must give you one by law)",
      "Check your insurer's portal under 'Claims' / 'EOBs', or contact your provider's billing department",
    ],
  },
  plan_document: {
    label: "Plan Document",
    short: "Plan Document",
    description: "Your insurance plan documents — SBC, EOC, or plan booklet",
    selectsAs: "plan_document" as const,
    // Two ways to GET the document (paths) + one explanation of WHAT it is
    // (lookFor). Rendered by FindTipsPanel's structured mode.
    findGuide: {
      paths: [
        {
          label: "Ask your HR or benefits team",
          body: "Employer-sponsored? They can send you the SBC or EOC directly.",
        },
        {
          label: "Check your insurer's portal",
          body: "Log in and look under 'Plan Documents' to download either one.",
        },
      ],
      lookForHeading: "What to ask for or look for",
      lookFor: [
        {
          term: "SBC",
          desc: "Summary of Benefits and Coverage (the federally-required 8-page summary from enrollment)",
        },
        {
          term: "EOC",
          desc: "Evidence of Coverage / plan certificate (the longer 50+ page document with full coverage details)",
        },
      ],
    },
  },
} as const;

export type PickerOptionKey = keyof typeof PICKER_OPTIONS;
export type PickerOption = (typeof PICKER_OPTIONS)[PickerOptionKey];
export type PlanFindGuide = (typeof PICKER_OPTIONS)["plan_document"]["findGuide"];

export const DOC_TYPES = {
  eob: {
    label: "Explanation of Benefits (EOB)",
    short: "EOB",
    description: "The document your insurance company sends after a claim is processed. It shows what was billed, what insurance paid, and what you owe.",
    tips: [
      "Check your insurer's online portal — most EOBs are available digitally",
      "Look for a document titled 'Explanation of Benefits' or 'EOB' in your mail or email",
      "Your EOB is NOT a bill — it's a summary from your insurance company",
    ],
  },
  itemized_bill: {
    label: "Itemized Medical Bill",
    short: "Itemized Bill",
    description: "A detailed bill from your healthcare provider listing every charge by procedure code. This is different from a summary statement.",
    tips: [
      "Call your provider's billing department and ask for an 'itemized statement'",
      "By law, providers must give you an itemized bill if you request one",
      "Look for CPT codes (5-digit numbers) — if you see them, it's itemized",
    ],
  },
  sbc: {
    label: "Summary of Benefits (SBC)",
    short: "SBC",
    description: "Your Summary of Benefits and Coverage — the standardized 8-page document from your insurer describing what your plan covers.",
    tips: [
      "Log into your insurer's portal and look for 'Summary of Benefits and Coverage'",
      "It's a standardized 8-page PDF required by federal law",
      "Your HR department can also provide this if you have employer-sponsored insurance",
    ],
  },
  plan_document: {
    label: "Full Plan Document",
    short: "Plan Doc",
    description: "Your full plan certificate or benefits booklet — the detailed document (often 50+ pages) with all plan rules, covered services, and exclusions.",
    tips: [
      "This is the longer document your insurer or employer provides — not the 8-page SBC",
      "Check your insurer's portal under 'Plan Documents' or 'Certificate of Coverage'",
      "Ask your HR department for the full plan certificate or benefits booklet",
    ],
  },
} as const;
