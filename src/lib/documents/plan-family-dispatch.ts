/**
 * Plan-family dispatch — the pure routing decision behind process-chunk's
 * `dispatchPlanOrEOC` (classifiedType ∈ sbc | eoc | plan_document).
 *
 * Extracted S195 so the two-flag precedence truth table is fixture-testable
 * (`scripts/calibration/fixtures/thesaurus-phase1a/plan-family-dispatch.ts`).
 *
 * S195 E2E finding: the S93 `unified_plan_doc_parser_v1` short-circuit (mig
 * 101) predates the P3.1A EOC parser and caught the WHOLE family — the
 * `eoc_parser_v1` branch sitting below it was unreachable in PROD whenever
 * unified was ON (i.e. always, since its global rollout). Every organic EOC
 * parse ran the plan_doc parser; `processEOCDocumentData` (and with it the P2
 * routing + `eoc_prose_prior_auth_v1`) never fired end-to-end. Rule 2 below is
 * the fix: an EOC with `eoc_parser_v1` ON routes to the EOC parser BEFORE the
 * unified short-circuit. Flipping `eoc_parser_v1` OFF restores the pre-S195
 * routing exactly — that flag is the rollback contract for this change.
 *
 * Decision order (each rule preserves a pre-S195 behavior unless marked FIX):
 *   1. eoc + degraded OCR        → reject_image_eoc   (Q-P3.1A-12 LOCK; flag-independent)
 *   2. eoc + eoc_parser_v1 ON    → eoc_parser         (Q-P3.1A-10 LOCK; FIX — now wins over unified)
 *   3. eoc + eoc_parser_v1 OFF   → plan_doc, coerced  (legacy fall-through; via unified or legacy)
 *   4. sbc + degraded OCR        → reject_image_sbc   (S55 audit #17; flag-independent)
 *   5. sbc|plan_document + unified ON  → plan_doc, coerced to 'plan_document'
 *      (S93 Stage 3: layout detector + federal-SBC supplement handle SBC
 *      patterns; sbc_parser_v1 / DR-3C voting bypassed — trade-off accepted in
 *      Stage 3 v1, 88.8% > 86.8% SBC-parser baseline)
 *   6. sbc|plan_document + unified OFF → plan_doc, UNcoerced (sbc keeps its
 *      classifiedType so processPlanDocumentData's own sbc branch applies)
 *   7. anything else → plan_doc, uncoerced (defensive; callers only pass the family)
 */

export interface PlanFamilyDispatchInput {
  /** classification.classifiedType as seen by process-chunk (effective doc type). */
  classifiedType: string;
  ocrTextLength: number;
  /** `unified_plan_doc_parser_v1` resolved for this user. */
  unifiedEnabled: boolean;
  /** `eoc_parser_v1` resolved for this user (only consulted for eoc). */
  eocParserEnabled: boolean;
  /** SBC_MIN_TEXT_CHARS — image-PDF refusal floor for sbc. */
  sbcMinTextChars: number;
  /** EOC_MIN_TEXT_CHARS — image-PDF refusal floor for eoc. */
  eocMinTextChars: number;
}

export type PlanFamilyDispatchDecision =
  | { route: "reject_image_eoc" }
  | { route: "reject_image_sbc" }
  | { route: "eoc_parser" }
  | {
      route: "plan_doc_parser";
      /** When true the caller coerces classifiedType to 'plan_document'. */
      coerceToPlanDocument: boolean;
      /** Which pre-existing path this decision corresponds to (drives log lines). */
      via: "unified" | "eoc_flag_off" | "legacy";
    };

export function resolvePlanFamilyDispatch(
  input: PlanFamilyDispatchInput,
): PlanFamilyDispatchDecision {
  const {
    classifiedType,
    ocrTextLength,
    unifiedEnabled,
    eocParserEnabled,
    sbcMinTextChars,
    eocMinTextChars,
  } = input;

  if (classifiedType === "eoc") {
    // Rule 1 — image-PDF refusal fires regardless of either flag (pre-S195 both
    // the unified branch and the legacy eoc branch checked it before any dispatch).
    if (ocrTextLength < eocMinTextChars) {
      return { route: "reject_image_eoc" };
    }
    // Rule 2 — THE S195 FIX: the dedicated EOC parser takes precedence over the
    // unified short-circuit when its flag is ON.
    if (eocParserEnabled) {
      return { route: "eoc_parser" };
    }
    // Rule 3 — flag OFF: identical destination either way (plan_doc parser,
    // classifiedType coerced); `via` only differentiates the log line.
    return {
      route: "plan_doc_parser",
      coerceToPlanDocument: true,
      via: unifiedEnabled ? "unified" : "eoc_flag_off",
    };
  }

  if (classifiedType === "sbc" && ocrTextLength < sbcMinTextChars) {
    // Rule 4 — flag-independent pre-S195: unified branch checked it inline,
    // legacy path checked it after the eoc branch.
    return { route: "reject_image_sbc" };
  }

  if (
    unifiedEnabled &&
    (classifiedType === "sbc" || classifiedType === "plan_document")
  ) {
    // Rule 5 — S93 Stage 3 unified routing, unchanged.
    return { route: "plan_doc_parser", coerceToPlanDocument: true, via: "unified" };
  }

  // Rules 6-7 — legacy path, classification passed through UNcoerced.
  return { route: "plan_doc_parser", coerceToPlanDocument: false, via: "legacy" };
}
