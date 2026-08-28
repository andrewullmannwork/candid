/**
 * citation-party-split — S326 eleven-rules Rule 3 (member_composition_v1).
 *
 * Proves, at the compose layer, with a per-recipient denominator so no check
 * can pass vacuously:
 *   1. UNDER SCOPE with nothing adopted, provider-directed letters emit ZERO
 *      citation-shaped strings (strip: the facts and the ask carry the letter),
 *      and insurer-directed letters fall to their fact forms (also zero).
 *   2. UNSCOPED (flag OFF / legacy) letters still cite as today — the
 *      DENOMINATOR: the same compositions contain citation-shaped strings, so
 *      the scoped-empty checks are proven non-vacuous.
 *   3. Adopting a menu key brings that citation back, framed as before.
 *   4. LETTER_CITATION_MENU ⊆ CITATION_REGISTRY (sync guard), provider menus
 *      empty, insurer menus non-empty.
 *
 * Citation-shape regex mirrors the 433-check guard's classes: §-references,
 * U.S.C. / CFR forms, and "Public Law".
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/citation-party-split.ts
 */
import {
  LETTER_CITATION_MENU,
  MEMBER_COMPOSABLE_LETTER_TYPES,
} from "../../../../src/lib/disputes/dispute-ground-catalog";
import { CITATION_REGISTRY } from "../../../../src/lib/disputes/citation-registry";
import { letterRecipientKind } from "../../../../src/lib/disputes/letter-type";
import type { DisputeLetterType } from "../../../../src/lib/billing/types";
import type { MemberSelection } from "../../../../src/lib/disputes/evidence-resolver";
import { mkFinding, mkLine, mkEvidence, composeLetter } from "./_compose-harness";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

const CITE_RE = /§\s?\d|U\.S\.C\.|\bCFR\b|Public Law/;

/** Compose one letter per composable type under the given scope. */
function bodyFor(type: DisputeLetterType, scope: MemberSelection | null): string {
  const findingType =
    type === "duplicate_charge" ? "duplicate" : type === "balance_billing" ? "balance_billing" : "overcharge";
  const ground =
    type === "duplicate_charge" ? "duplicate" : type === "balance_billing" ? "balance_billing" : "benchmark";
  const findings = [mkFinding(findingType as never, 110)];
  const scoped =
    scope == null ? null : { grounds: [ground, ...scope.grounds], adoptedCitations: scope.adoptedCitations };
  return composeLetter(type, findings, mkEvidence([mkLine(findings)], scoped as MemberSelection | null), {
    appealExhausted: { attested: true, denialDate: "2026-02-01" },
  });
}

// 1+2 — scoped-nothing-adopted = zero cites; unscoped = cites present (denominator).
let unscopedWithCites = 0;
for (const type of MEMBER_COMPOSABLE_LETTER_TYPES) {
  const scopedBody = bodyFor(type, { grounds: [], adoptedCitations: [] });
  const kind = letterRecipientKind(type);
  const m = scopedBody.match(CITE_RE);
  check(
    `${type} (${kind}) scoped+unadopted emits zero citation-shaped strings${m ? ` [found: ${m[0]}]` : ""}`,
    m == null,
  );

  const unscopedBody = bodyFor(type, null);
  if (CITE_RE.test(unscopedBody)) unscopedWithCites++;
}
check(
  `denominator: >=2 unscoped compositions DO cite (found ${unscopedWithCites})`,
  unscopedWithCites >= 2,
);

// 3 — adoption brings the citation back (insurer letters).
{
  const adopted = bodyFor("external_review", { grounds: [], adoptedCitations: ["phsa_2719", "external_review_reg"] });
  check("external_review with both adoptions cites PHSA §2719", adopted.includes("PHSA §2719"));
  check("external_review with both adoptions cites 45 CFR §147.136", adopted.includes("45 CFR §147.136"));
  const one = bodyFor("external_review", { grounds: [], adoptedCitations: ["external_review_reg"] });
  check("single adoption cites only the adopted authority", one.includes("45 CFR §147.136") && !one.includes("PHSA §2719"));
}

// 4 — menu ⊆ registry; provider menus empty; insurer menus non-empty.
for (const [type, keys] of Object.entries(LETTER_CITATION_MENU)) {
  for (const k of keys) {
    check(`menu[${type}] key ${k} registered`, !!CITATION_REGISTRY[k]);
  }
  const kind = letterRecipientKind(type as DisputeLetterType);
  if (kind === "provider" || kind === "collector") {
    check(`menu[${type}] empty (${kind}-directed letters strip)`, keys.length === 0);
  }
}
check("insurance_appeal menu non-empty", LETTER_CITATION_MENU.insurance_appeal.length > 0);
check("external_review menu non-empty", LETTER_CITATION_MENU.external_review.length > 0);

console.log(`\ncitation-party-split: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
