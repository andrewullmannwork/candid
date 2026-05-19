/**
 * Unit tests for shouldHaltForUserConfirmation (S99 B5 Fix-B).
 * Run: `npx tsx scripts/test-shouldHaltForUserConfirmation.ts`
 * Exit 0 on all-pass; 1 on any failure.
 *
 * Covers the path matrix walked in the S99 B5 planning conversation:
 *   - Intra-class same-class (no halt)
 *   - Real cross-class disagreement in picker vocabulary (halt fires)
 *   - Classifier returns "other" — the FP that motivated this fix
 *   - Classifier returns "insurance_card" — another FP closed by Fix-B
 *   - Classifier returns "eoc" — plan_doc class but not picker-renderable
 *   - Null / undefined inputs (no halt; defensive)
 *
 * If any of these regress, the halt either fires spuriously (degenerate modal
 * with one button) or stops firing on a real cross-class case (silent wrong-pick
 * downstream). Both are launch-blocking flywheel correctness issues.
 */
import { shouldHaltForUserConfirmation } from "../src/lib/classifier/fallback";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function expect(
  label: string,
  result: boolean,
  expected: boolean,
): void {
  if (result === expected) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}  expected=${expected} actual=${result}`);
    failures.push(label);
    fail++;
  }
}

console.log("shouldHaltForUserConfirmation — unit tests\n");

// ── Same-class scenarios (no halt) ──────────────────────────────────────────
expect(
  "T1 user=plan_document, classifier=sbc → no halt (intra-plan_doc class)",
  shouldHaltForUserConfirmation("plan_document", "sbc"),
  false,
);
expect(
  "T2 user=sbc, classifier=plan_document → no halt (intra-plan_doc class)",
  shouldHaltForUserConfirmation("sbc", "plan_document"),
  false,
);
expect(
  "T3 user=eob, classifier=itemized_bill → no halt (intra-bill class)",
  shouldHaltForUserConfirmation("eob", "itemized_bill"),
  false,
);
expect(
  "T4 user=itemized_bill, classifier=eob → no halt (intra-bill class)",
  shouldHaltForUserConfirmation("itemized_bill", "eob"),
  false,
);

// ── Real cross-class disagreement (halt fires) ─────────────────────────────
expect(
  "T5 user=eob, classifier=sbc → HALT (bill vs plan_doc — the original B5 trigger)",
  shouldHaltForUserConfirmation("eob", "sbc"),
  true,
);
expect(
  "T6 user=itemized_bill, classifier=plan_document → HALT (bill vs plan_doc)",
  shouldHaltForUserConfirmation("itemized_bill", "plan_document"),
  true,
);
expect(
  "T7 user=plan_document, classifier=eob → HALT (plan_doc vs bill, inverse)",
  shouldHaltForUserConfirmation("plan_document", "eob"),
  true,
);
expect(
  "T8 user=sbc, classifier=itemized_bill → HALT (plan_doc vs bill)",
  shouldHaltForUserConfirmation("sbc", "itemized_bill"),
  true,
);

// ── Fix-B closes these FPs ─────────────────────────────────────────────────
expect(
  "T9 user=plan_document, classifier='other' → NO HALT (other not in PICKER_TYPES; would render degenerate modal)",
  shouldHaltForUserConfirmation("plan_document", "other"),
  false,
);
expect(
  "T10 user=eob, classifier='other' → NO HALT (other not in PICKER_TYPES)",
  shouldHaltForUserConfirmation("eob", "other"),
  false,
);
expect(
  "T11 user=plan_document, classifier='insurance_card' → NO HALT (insurance_card not in PICKER_TYPES)",
  shouldHaltForUserConfirmation("plan_document", "insurance_card"),
  false,
);
expect(
  "T12 user=sbc, classifier='eoc' → NO HALT (eoc not in PICKER_TYPES; same class anyway → no real disagreement)",
  shouldHaltForUserConfirmation("sbc", "eoc"),
  false,
);
expect(
  "T13 user=eob, classifier='eoc' → NO HALT (eoc not in PICKER_TYPES; bill-parser sanity gate handles page-count-based defense if user proceeds)",
  shouldHaltForUserConfirmation("eob", "eoc"),
  false,
);

// ── Defensive: null/empty inputs (no halt) ─────────────────────────────────
expect(
  "T14 user=null, classifier=sbc → NO HALT (null userPick; nothing to confirm)",
  shouldHaltForUserConfirmation(null, "sbc"),
  false,
);
expect(
  "T15 user=eob, classifier=null → NO HALT (null verdict; nothing to compare against)",
  shouldHaltForUserConfirmation("eob", null),
  false,
);
expect(
  "T16 user=null, classifier=null → NO HALT",
  shouldHaltForUserConfirmation(null, null),
  false,
);
expect(
  "T17 user=undefined, classifier=sbc → NO HALT",
  shouldHaltForUserConfirmation(undefined, "sbc"),
  false,
);
expect(
  "T18 user='', classifier='sbc' → NO HALT (empty string is falsy)",
  shouldHaltForUserConfirmation("", "sbc"),
  false,
);

// ── Defensive: out-of-vocabulary userPick (no halt) ────────────────────────
// If the picker UI is ever extended (or someone hand-crafts an upload request),
// non-picker-vocabulary userPick must NOT trigger the halt — the modal can't
// render a button for an unknown type.
expect(
  "T19 user='bogus', classifier=sbc → NO HALT (userPick not in PICKER_TYPES; modal can't render)",
  shouldHaltForUserConfirmation("bogus", "sbc"),
  false,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
process.exit(0);
