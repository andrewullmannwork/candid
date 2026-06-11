/**
 * Unit tests for resolveEffectiveDocType. Mirrors progress.md S91 test plan.
 * Run: `npx tsx scripts/test-effective-doc-type.ts`
 * Exit 0 on all-pass; 1 on any failure.
 */
import {
  resolveEffectiveDocType,
  DEFAULT_DOC_TYPE_OVERRIDE_CONFIG,
  type DocTypeOverrideConfig,
  type DocTypeResolution,
} from "../src/lib/documents/effective-doc-type";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function expect(
  label: string,
  resolution: DocTypeResolution,
  expected: Partial<DocTypeResolution>,
): void {
  const failures_this: string[] = [];
  for (const key of Object.keys(expected) as Array<keyof DocTypeResolution>) {
    if (resolution[key] !== expected[key]) {
      failures_this.push(`  ${key}: expected=${expected[key]} actual=${resolution[key]}`);
    }
  }
  if (failures_this.length === 0) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}`);
    failures_this.forEach((f) => console.log(f));
    failures.push(label);
    fail++;
  }
}

console.log("resolveEffectiveDocType — unit tests\n");

// Test 1: user=sbc, classifier=sbc@0.9, pages=10 → user_pick (no override)
expect(
  "T1 user=sbc, classifier=sbc@0.9, pages=10 → user_pick",
  resolveEffectiveDocType("sbc", "sbc", 0.9, 10),
  { effectiveDocType: "sbc", overrideReason: "user_pick" },
);

// Test 2: user=sbc, classifier=plan_document@0.9, pages=150 → classifier_high_confidence (Cigna 2024 case)
expect(
  "T2 user=sbc, classifier=plan_document@0.9, pages=150 → classifier_high_confidence (Cigna 2024 EOC case)",
  resolveEffectiveDocType("sbc", "plan_document", 0.9, 150),
  { effectiveDocType: "plan_document", overrideReason: "classifier_high_confidence" },
);

// Test 3: user=sbc, classifier=sbc@0.6, pages=50 → page_count_safety_net (low conf + over ceiling)
expect(
  "T3 user=sbc, classifier=sbc@0.6, pages=50 → page_count_safety_net (low conf + over ceiling → plan_document)",
  resolveEffectiveDocType("sbc", "sbc", 0.6, 50),
  { effectiveDocType: "plan_document", overrideReason: "page_count_safety_net" },
);

// Test 4: user=plan_document, classifier=sbc@0.9, pages=8 → classifier_high_confidence (reverse case)
expect(
  "T4 user=plan_document, classifier=sbc@0.9, pages=8 → classifier_high_confidence (reverse: SBC mis-picked as Plan Doc)",
  resolveEffectiveDocType("plan_document", "sbc", 0.9, 8),
  { effectiveDocType: "sbc", overrideReason: "classifier_high_confidence" },
);

// Test 5: user=plan_document, classifier=sbc@0.6, pages=12 → user_pick_classifier_low_confidence (NO override — SOB protection)
expect(
  "T5 user=plan_document, classifier=sbc@0.6, pages=12 → user_pick_classifier_low_confidence (SOB protection — no override)",
  resolveEffectiveDocType("plan_document", "sbc", 0.6, 12),
  { effectiveDocType: "plan_document", overrideReason: "user_pick_classifier_low_confidence" },
);

// Test 6: user=eob, classifier=itemized_bill@0.85, pages=8 → classifier_high_confidence (bill type swap)
expect(
  "T6 user=eob, classifier=itemized_bill@0.85, pages=8 → classifier_high_confidence (bill type swap)",
  resolveEffectiveDocType("eob", "itemized_bill", 0.85, 8),
  { effectiveDocType: "itemized_bill", overrideReason: "classifier_high_confidence" },
);

// Test 7: user=sbc, classifier=eoc@0.95, pages=30 → classifier_high_confidence (granularity bump)
expect(
  "T7 user=sbc, classifier=eoc@0.95, pages=30 → classifier_high_confidence (granularity bump to eoc)",
  resolveEffectiveDocType("sbc", "eoc", 0.95, 30),
  { effectiveDocType: "eoc", overrideReason: "classifier_high_confidence" },
);

// Test 8: user=sbc, classifier=plan_document@0.5, pages=22 → page_count_safety_net (low classifier conf, page-count rescue)
expect(
  "T8 user=sbc, classifier=plan_document@0.5, pages=22 → page_count_safety_net (low conf, pages > 20 → plan_document)",
  resolveEffectiveDocType("sbc", "plan_document", 0.5, 22),
  { effectiveDocType: "plan_document", overrideReason: "page_count_safety_net" },
);

// Test 9: kill switch — config.enabled=false → user_pick always (no override)
const killedConfig: DocTypeOverrideConfig = {
  ...DEFAULT_DOC_TYPE_OVERRIDE_CONFIG,
  enabled: false,
};
expect(
  "T9 kill switch (config.enabled=false): user=sbc, classifier=plan_document@0.99 → user_pick (no override)",
  resolveEffectiveDocType("sbc", "plan_document", 0.99, 150, killedConfig),
  { effectiveDocType: "sbc", overrideReason: "feature_disabled" },
);

// Test 10: unrecognized classifier output → user_pick (don't trust unknown verdicts)
expect(
  "T10 user=sbc, classifier=card@0.95, pages=10 → user_pick (unrecognized classifier output, don't override)",
  resolveEffectiveDocType("sbc", "card", 0.95, 10),
  { effectiveDocType: "sbc", overrideReason: "user_pick_classifier_low_confidence" },
);

// Test 11: tunable threshold respected
const tunedConfig: DocTypeOverrideConfig = {
  enabled: true,
  classifier_confidence_override: 0.7, // lowered from default 0.8
  sbc_max_pages: 20,
  family_refinement_confidence: 0.5, // S195 Rule 1.5 (default value)
};
expect(
  "T11 tunable threshold (0.7): user=sbc, classifier=plan_document@0.75 → classifier_high_confidence (below default 0.8 but above tuned 0.7)",
  resolveEffectiveDocType("sbc", "plan_document", 0.75, 15, tunedConfig),
  { effectiveDocType: "plan_document", overrideReason: "classifier_high_confidence" },
);

// Test 12: classifier agreed with user, even with low confidence → user_pick (not low_conf)
expect(
  "T12 user=sbc, classifier=sbc@0.3, pages=10 → user_pick (classifier agreed despite low conf)",
  resolveEffectiveDocType("sbc", "sbc", 0.3, 10),
  { effectiveDocType: "sbc", overrideReason: "user_pick" },
);

// Test 13: boundary — pages exactly at SBC_MAX_PAGES (20) → no safety-net trigger
expect(
  "T13 boundary: user=sbc, classifier=sbc@0.6, pages=20 → user_pick (boundary; safety net is > 20, not >= 20)",
  resolveEffectiveDocType("sbc", "sbc", 0.6, 20),
  { effectiveDocType: "sbc", overrideReason: "user_pick" },
);

// Test 14: boundary — confidence exactly at threshold (0.8) → override fires
expect(
  "T14 boundary: user=sbc, classifier=plan_document@0.8, pages=10 → classifier_high_confidence (boundary inclusive)",
  resolveEffectiveDocType("sbc", "plan_document", 0.8, 10),
  { effectiveDocType: "plan_document", overrideReason: "classifier_high_confidence" },
);

// ─── S92 Stage 1: Bill-vs-Plan-Doc cross-family cases ──────────────────────
// The 2-card picker collapses 4 user-pick types into 2 user-facing families:
//   "Bill" card → wire-type "eob" (default; classifier may sub-classify to itemized_bill)
//   "Plan Document" card → wire-type "plan_document" (default; classifier may sub-classify to sbc / eoc)
// Resolver must handle cross-family override cases — when user picks "Bill"
// (wire=eob) but classifier sees a plan-doc family type, or vice versa.

// Test 15: Cigna 2024 EOC case if user had picked "Bill" instead of "Plan Document"
expect(
  "T15 Bill→Plan: user=eob, classifier=plan_document@0.9, pages=86 → classifier_high_confidence (Cigna 2024 EOC mis-picked as Bill)",
  resolveEffectiveDocType("eob", "plan_document", 0.9, 86),
  { effectiveDocType: "plan_document", overrideReason: "classifier_high_confidence" },
);

// Test 16: User picks "Plan Document" on an itemized hospital bill
expect(
  "T16 Plan→Bill: user=plan_document, classifier=itemized_bill@0.92, pages=4 → classifier_high_confidence (bill mis-picked as Plan Doc)",
  resolveEffectiveDocType("plan_document", "itemized_bill", 0.92, 4),
  { effectiveDocType: "itemized_bill", overrideReason: "classifier_high_confidence" },
);

// Test 17: User picks "Bill" on a 150-page EOC → granular eoc sub-type bump
expect(
  "T17 Bill→EOC: user=eob, classifier=eoc@0.95, pages=150 → classifier_high_confidence (eoc granularity bump)",
  resolveEffectiveDocType("eob", "eoc", 0.95, 150),
  { effectiveDocType: "eoc", overrideReason: "classifier_high_confidence" },
);

// Test 18: User picks "Bill", classifier sees plan-doc with LOW conf — no override (trust user)
expect(
  "T18 Bill→Plan low-conf: user=eob, classifier=plan_document@0.65, pages=10 → user_pick_classifier_low_confidence (no override)",
  resolveEffectiveDocType("eob", "plan_document", 0.65, 10),
  { effectiveDocType: "eob", overrideReason: "user_pick_classifier_low_confidence" },
);

// Test 19: User picks "Plan Document", classifier sees bill with LOW conf — no override
expect(
  "T19 Plan→Bill low-conf: user=plan_document, classifier=eob@0.5, pages=4 → user_pick_classifier_low_confidence (no override)",
  resolveEffectiveDocType("plan_document", "eob", 0.5, 4),
  { effectiveDocType: "plan_document", overrideReason: "user_pick_classifier_low_confidence" },
);

// Test 20: User picks "Bill", classifier sees sbc@0.9, pages=25.
// Current behavior: Rule 1 fires (eob → sbc); Rule 2 only fires when userPick==="sbc", so
// no page-count safety net applies. Effective = sbc. The Subplan §4.2.1 originally
// proposed chaining Rule 1 → Rule 2 (post-override sbc + pages > 20 → force plan_document),
// which would require a small resolver code change. Capturing current behavior here;
// Andrew may revisit if the Stage 0 head-to-head iteration shows 25-page "sbc" mis-classifies
// in PROD are common enough to warrant the chain.
expect(
  "T20 Bill→SBC@9pages overflow: user=eob, classifier=sbc@0.9, pages=25 → classifier_high_confidence (Rule 1 fires; Rule 2 does NOT chain — userPick≠sbc)",
  resolveEffectiveDocType("eob", "sbc", 0.9, 25),
  { effectiveDocType: "sbc", overrideReason: "classifier_high_confidence" },
);

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
if (fail > 0) {
  console.log("Failed cases:", failures.join("; "));
  process.exit(1);
}
process.exit(0);
