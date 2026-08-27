/**
 * ground-mapping-sync — S326 eleven-rules Rule 1+2: the published mapping's
 * two halves stay together, and the member-facing copy stays in the fact zone.
 *
 * Proves: (1) every ground carries non-empty member copy (label / description /
 * "what counts as this"); (2) the machine mapping (deriveFindingToGround) is
 * exactly the catalog's fromFindings inverted, one ground per finding; (3)
 * every ground-mapped finding type has a NEUTRAL fact template (or the ground
 * is non-finding-backed by design); (4) the banned-verdict vocabulary appears
 * NOWHERE in the member copy or the rendered fact statements (Rule 1's line:
 * subject = the document's content, never the member's legal position);
 * (5) groundMemberParty pins — including the empty-obligation provider
 * fallback, so a future empty-obligation INSURER ground fails loud.
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/ground-mapping-sync.ts
 */
import {
  DISPUTE_GROUND_CATALOG,
  ALL_DISPUTE_GROUND_TYPES,
  deriveFindingToGround,
  groundMemberParty,
} from "../../../../src/lib/disputes/dispute-ground-catalog";
import type { DisputeGroundType } from "../../../../src/lib/disputes/dispute-grounds";
import {
  COMPOSITION_FACT_TEMPLATES,
  factStatement,
} from "../../../../src/components/disputes/composition-copy";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

// 1 — member copy present on every ground.
for (const g of ALL_DISPUTE_GROUND_TYPES) {
  const spec = DISPUTE_GROUND_CATALOG[g];
  check(`${g} memberLabel non-empty`, spec.memberLabel.trim().length > 0);
  check(`${g} memberDescription non-empty`, spec.memberDescription.trim().length > 0);
  check(`${g} mappingPlainLanguage non-empty`, spec.mappingPlainLanguage.trim().length > 0);
}

// 2 — the machine mapping is the catalog inverted, one ground per finding.
{
  const map = deriveFindingToGround();
  let entries = 0;
  for (const g of ALL_DISPUTE_GROUND_TYPES) {
    for (const f of DISPUTE_GROUND_CATALOG[g].fromFindings) {
      entries++;
      check(`finding ${f} maps to ${g}`, map[f] === g);
    }
  }
  check("mapping has exactly the catalog's finding entries", Object.keys(map).length === entries);
  check("mapping denominator sane (>=7 finding types)", entries >= 7);
}

// 3 — every finding-backed ground's finding types have a neutral fact template.
for (const g of ALL_DISPUTE_GROUND_TYPES) {
  for (const f of DISPUTE_GROUND_CATALOG[g].fromFindings) {
    check(`fact template exists for ${f}`, typeof COMPOSITION_FACT_TEMPLATES[f] === "function");
  }
}

// 4 — the banned-verdict vocabulary never appears in member-facing copy.
//     (Rule 1: any sentence whose subject is the user's legal position fails.)
const BANNED = [
  "violation",
  "overcharged",
  "you are entitled",
  "you're entitled",
  "you should",
  "we recommend",
  "illegal",
  "fraud",
  "requires them to",
  "unbillable",
];
function scan(label: string, text: string) {
  const lower = text.toLowerCase();
  for (const b of BANNED) {
    check(`${label} avoids "${b}"`, !lower.includes(b));
  }
}
for (const g of ALL_DISPUTE_GROUND_TYPES) {
  const spec = DISPUTE_GROUND_CATALOG[g];
  scan(`${g} copy`, `${spec.memberLabel} ${spec.memberDescription} ${spec.mappingPlainLanguage}`);
}
for (const [t, tpl] of Object.entries(COMPOSITION_FACT_TEMPLATES)) {
  scan(
    `fact template ${t}`,
    tpl({ lineNumber: 1, description: "Office visit", code: "99213", billedAmount: 240, findingType: t, benchmarkAmount: 130 }),
  );
}
scan(
  "factStatement composed line",
  factStatement({ lineNumber: 3, description: "Lab panel", code: "80053", billedAmount: 88, findingType: "duplicate" }),
);

// 5 — party pins (incl. the empty-obligation provider fallback).
const EXPECTED_PARTY: Record<DisputeGroundType, "insurer" | "provider" | "both"> = {
  service_not_rendered: "provider",
  balance_billing: "both",
  duplicate: "provider", // empty obligations → fallback (provider instrument)
  unbundling: "provider", // empty obligations → fallback
  coverage_contradiction: "insurer",
  cost_share_misapplication: "insurer",
  benchmark: "provider", // empty obligations → fallback
  unallocated_balance: "provider",
  coding_peer: "provider",
  chargemaster: "provider",
  provider_overpayment: "provider",
};
for (const g of ALL_DISPUTE_GROUND_TYPES) {
  check(`${g} party = ${EXPECTED_PARTY[g]}`, groundMemberParty(g) === EXPECTED_PARTY[g]);
}

console.log(`\nground-mapping-sync: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
