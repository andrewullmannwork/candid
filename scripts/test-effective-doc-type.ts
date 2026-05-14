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

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
if (fail > 0) {
  console.log("Failed cases:", failures.join("; "));
  process.exit(1);
}
process.exit(0);
