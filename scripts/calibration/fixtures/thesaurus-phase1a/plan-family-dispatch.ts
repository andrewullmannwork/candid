/**
 * S195 — plan-family dispatch + doc-type refinement fixture (no DB, no Haiku).
 *
 *   npx tsx scripts/calibration/fixtures/thesaurus-phase1a/plan-family-dispatch.ts
 *
 * Proves the two pure functions behind the S195 E2E finding (the flag-ON EOC
 * parser was unreachable in PROD):
 *
 *   PART 1 — `resolvePlanFamilyDispatch` truth table (process-chunk dispatch):
 *     THE FIX: eoc + eoc_parser_v1 ON → eoc_parser even when
 *     unified_plan_doc_parser_v1 is ON (pre-S195 the unified short-circuit
 *     swallowed the whole family). Every other cell asserts pre-S195 behavior
 *     byte-for-byte: refusal floors flag-independent and ahead of flag gates;
 *     unified coerces sbc/plan_document/eoc-flag-OFF to 'plan_document';
 *     legacy sbc/plan_document pass through UNcoerced (sbc keeps its own
 *     downstream branch); eoc-flag-OFF coerces on both unified states.
 *
 *   PART 2 — `resolveEffectiveDocType` Rule 1.5 family refinement (upload):
 *     a generic plan_document pick adopts the classifier's eoc verdict at the
 *     family_refinement_confidence bar (default 0.5) with long-form page
 *     corroboration (pages > sbc_max_pages). eoc-ONLY: plan_document → sbc
 *     stays at Rule 1's full bar (S91 "SOB protection" lock, test T5) — that
 *     no-refine contract is pinned here too. Asserts the observed S195 PROD
 *     case (eoc@0.69, 99 pages, 0.95 Rule-1 bar) now resolves eoc, AND that
 *     Rules 1/2 + kill switch + non-generic picks are untouched (incl. the
 *     adversarial-pdf-ingest self-call shape).
 */
import {
  resolvePlanFamilyDispatch,
  type PlanFamilyDispatchDecision,
} from "@/lib/documents/plan-family-dispatch";
import {
  resolveEffectiveDocType,
  type DocTypeOverrideConfig,
  type DocTypePick,
} from "@/lib/documents/effective-doc-type";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.error(`  FAIL  ${name}`);
  }
}

// ── PART 1 — dispatch truth table ────────────────────────────────────────────
const SBC_MIN = 500;
const EOC_MIN = 1000;
const BIG = 250_000;
const TINY = 50;

function dispatch(
  classifiedType: string,
  ocrTextLength: number,
  unifiedEnabled: boolean,
  eocParserEnabled: boolean,
): PlanFamilyDispatchDecision {
  return resolvePlanFamilyDispatch({
    classifiedType,
    ocrTextLength,
    unifiedEnabled,
    eocParserEnabled,
    sbcMinTextChars: SBC_MIN,
    eocMinTextChars: EOC_MIN,
  });
}
const isPlanDoc = (
  d: PlanFamilyDispatchDecision,
  coerce: boolean,
  via: "unified" | "eoc_flag_off" | "legacy",
) => d.route === "plan_doc_parser" && d.coerceToPlanDocument === coerce && d.via === via;

console.log("PART 1 — resolvePlanFamilyDispatch truth table:");
check(
  "THE S195 FIX: eoc + eocFlag ON + unified ON → eoc_parser",
  dispatch("eoc", BIG, true, true).route === "eoc_parser",
);
check(
  "eoc + eocFlag ON + unified OFF → eoc_parser",
  dispatch("eoc", BIG, false, true).route === "eoc_parser",
);
check(
  "eoc + eocFlag OFF + unified ON → plan_doc coerced (via unified)",
  isPlanDoc(dispatch("eoc", BIG, true, false), true, "unified"),
);
check(
  "eoc + eocFlag OFF + unified OFF → plan_doc coerced (via eoc_flag_off)",
  isPlanDoc(dispatch("eoc", BIG, false, false), true, "eoc_flag_off"),
);
check(
  "eoc image-PDF → reject_image_eoc even with both flags ON (refusal precedes flags)",
  dispatch("eoc", TINY, true, true).route === "reject_image_eoc",
);
check(
  "eoc image-PDF → reject_image_eoc with both flags OFF (flag-independent)",
  dispatch("eoc", TINY, false, false).route === "reject_image_eoc",
);
check(
  "sbc image-PDF + unified ON → reject_image_sbc",
  dispatch("sbc", TINY, true, false).route === "reject_image_sbc",
);
check(
  "sbc image-PDF + unified OFF → reject_image_sbc",
  dispatch("sbc", TINY, false, false).route === "reject_image_sbc",
);
check(
  "sbc + unified ON → plan_doc coerced (S93 Stage 3 unchanged)",
  isPlanDoc(dispatch("sbc", BIG, true, false), true, "unified"),
);
check(
  "sbc + unified OFF → plan_doc UNcoerced (legacy sbc branch downstream)",
  isPlanDoc(dispatch("sbc", BIG, false, false), false, "legacy"),
);
check(
  "plan_document + unified ON → plan_doc coerced",
  isPlanDoc(dispatch("plan_document", BIG, true, false), true, "unified"),
);
check(
  "plan_document + unified OFF → plan_doc UNcoerced (legacy)",
  isPlanDoc(dispatch("plan_document", BIG, false, false), false, "legacy"),
);
check(
  "plan_document + tiny OCR → NO refusal (pre-S195: no floor for plan_document)",
  isPlanDoc(dispatch("plan_document", TINY, true, false), true, "unified"),
);
check(
  "non-family type (eob, defensive) → plan_doc UNcoerced legacy",
  isPlanDoc(dispatch("eob", BIG, true, false), false, "legacy"),
);
check(
  "eocParserEnabled is irrelevant to sbc (guard isolation)",
  isPlanDoc(dispatch("sbc", BIG, true, true), true, "unified"),
);

// ── PART 2 — Rule 1.5 family refinement ─────────────────────────────────────
// PROD-like config: Rule-1 bar raised to 0.95 (the live doc_type_override_v1
// config), refinement at the 0.5 default.
const PROD_CFG: DocTypeOverrideConfig = {
  enabled: true,
  classifier_confidence_override: 0.95,
  sbc_max_pages: 20,
  family_refinement_confidence: 0.5,
};
const eff = (
  pick: DocTypePick,
  classified: string,
  conf: number,
  pages: number,
  cfg: DocTypeOverrideConfig = PROD_CFG,
) => resolveEffectiveDocType(pick, classified, conf, pages, cfg);

console.log("\nPART 2 — resolveEffectiveDocType Rule 1.5 (family refinement):");
{
  const r = eff("plan_document", "eoc", 0.69, 99);
  check(
    "THE S195 PROD case: plan_document pick + eoc@0.69 + 99p → eoc (family_refinement)",
    r.effectiveDocType === "eoc" && r.overrideReason === "family_refinement",
  );
}
check(
  "below refinement bar: eoc@0.40 + 99p → plan_document (low-confidence record kept)",
  eff("plan_document", "eoc", 0.4, 99).overrideReason === "user_pick_classifier_low_confidence",
);
check(
  "short doc blocks eoc refinement: eoc@0.69 + 12p → plan_document",
  eff("plan_document", "eoc", 0.69, 12).effectiveDocType === "plan_document",
);
check(
  "unknown pageCount (0) never refines: eoc@0.69 + 0p → plan_document",
  eff("plan_document", "eoc", 0.69, 0).effectiveDocType === "plan_document",
);
{
  // S91 SOB-protection lock (test T5): a short plan_document pick must NOT be
  // refined to sbc on moderate confidence — SOB/SPD look-alikes would land in
  // SBC-specific handling. eoc is the ONLY Rule 1.5 refinement target.
  const r = eff("plan_document", "sbc", 0.6, 8);
  check(
    "NO sbc refinement (S91 T5 SOB protection): sbc@0.60 + 8p → plan_document kept",
    r.effectiveDocType === "plan_document" &&
      r.overrideReason === "user_pick_classifier_low_confidence",
  );
}
check(
  "NO sbc refinement at any length: sbc@0.60 + 25p → plan_document kept",
  eff("plan_document", "sbc", 0.6, 25).effectiveDocType === "plan_document",
);
check(
  "sbc adoption still available via Rule 1's full bar: sbc@0.96 + 8p → sbc (classifier_high_confidence)",
  eff("plan_document", "sbc", 0.96, 8).overrideReason === "classifier_high_confidence",
);
{
  const r = eff("plan_document", "eoc", 0.96, 99);
  check(
    "Rule 1 precedence intact: eoc@0.96 → eoc via classifier_high_confidence (not refinement)",
    r.effectiveDocType === "eoc" && r.overrideReason === "classifier_high_confidence",
  );
}
{
  const r = eff("plan_document", "eoc", 0.69, 99, { ...PROD_CFG, enabled: false });
  check(
    "kill switch wins: enabled=false → user pick (feature_disabled)",
    r.effectiveDocType === "plan_document" && r.overrideReason === "feature_disabled",
  );
}
{
  // Pre-S195 behavior preserved on the OLD doc's path: sbc pick + 99 pages →
  // Rule 2 page-count net adopts the classifier's eoc verdict.
  const r = eff("sbc", "eoc", 0.69, 99);
  check(
    "Rule 2 untouched: sbc pick + eoc@0.69 + 99p → eoc (page_count_safety_net)",
    r.effectiveDocType === "eoc" && r.overrideReason === "page_count_safety_net",
  );
}
check(
  "refinement is plan_document-pick ONLY: eob pick + plan_document@0.69 → eob kept",
  eff("eob", "plan_document", 0.69, 40).effectiveDocType === "eob",
);
{
  // adversarial-pdf-ingest self-call shape: doc_type already 'eoc' is passed
  // back in as the pick (TS-cast at the call site) — must stay stable.
  const r = eff("eoc" as unknown as DocTypePick, "eoc", 0.69, 99);
  check(
    "ingest self-call stability: pick=eoc + classifier eoc → eoc (user_pick)",
    r.effectiveDocType === "eoc" && r.overrideReason === "user_pick",
  );
}
{
  // Default-config consumers (adversarial ingest, cold-start) — Rule 1 default
  // bar 0.8 still beats refinement when reached.
  const r1 = resolveEffectiveDocType("plan_document", "eoc", 0.85, 99);
  const r2 = resolveEffectiveDocType("plan_document", "eoc", 0.79, 99);
  check(
    "default config: eoc@0.85 → classifier_high_confidence (Rule 1 first)",
    r1.effectiveDocType === "eoc" && r1.overrideReason === "classifier_high_confidence",
  );
  check(
    "default config: eoc@0.79 → family_refinement (between bars)",
    r2.effectiveDocType === "eoc" && r2.overrideReason === "family_refinement",
  );
}

console.log(`\n${pass}/${pass + fail} assertions passed.`);
if (fail > 0) {
  console.error(`${fail} FAILED`);
  process.exit(1);
}
