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
  FINDING_CARD_COPY,
  buildFindingCards,
  lineRefLabel,
  type CompositionEntryInput,
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

// 3 — every finding-backed ground's finding types have card copy (v4).
for (const g of ALL_DISPUTE_GROUND_TYPES) {
  for (const f of DISPUTE_GROUND_CATALOG[g].fromFindings) {
    check(`card copy exists for ${f}`, FINDING_CARD_COPY[f] != null);
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
for (const [t, copyDef] of Object.entries(FINDING_CARD_COPY)) {
  const rendered = [
    copyDef.fact({ count: 2 }),
    copyDef.math({ billed: 240, benchmark: 130, date: "June 9, 2025", count: 2 }) ?? "",
    copyDef.helper ? copyDef.helper({ count: 2 }) : "",
  ].join(" ");
  scan(`card copy ${t}`, rendered);
}

// ---------------------------------------------------------------------------
// 4b — the v4 card builder pins (Andrew-approved mock): BILL ORDER (never
// dollars/severity), one card per finding (the duplicate pair is ONE
// decision), unmapped facts render no card, the other-recipient split, and
// Andrew's helper wording pattern verbatim.
// ---------------------------------------------------------------------------
{
  const e = (over: Partial<CompositionEntryInput>): CompositionEntryInput => ({
    findingId: "f1",
    findingType: "overcharge",
    lineNumber: 1,
    serviceName: "Office visit",
    code: "99213",
    billedAmount: 450,
    benchmarkAmount: 92.47,
    serviceDate: "June 9, 2025",
    ...over,
  });
  const { cards, otherTrack } = buildFindingCards(
    [
      // deliberately out of order + a big-dollar late line to prove no dollar sort
      e({ findingId: "d1", findingType: "duplicate", lineNumber: 2 }),
      e({ findingId: "ov3", findingType: "overcharge", lineNumber: 3, billedAmount: 9000 }),
      e({ findingId: "d1", findingType: "duplicate", lineNumber: 1 }),
      e({ findingId: "cs4", findingType: "zero_cost_share_overcharge", lineNumber: 4 }),
      e({ findingId: "un5", findingType: "uncategorized_service", lineNumber: 5 }),
    ],
    "provider",
  );
  check("duplicate pair groups into ONE card", cards.filter((c) => c.findingType === "duplicate").length === 1);
  check(
    "grouped card carries both lines ascending",
    JSON.stringify(cards.find((c) => c.findingType === "duplicate")?.lineNumbers) === "[1,2]",
  );
  check(
    "cards sort by BILL ORDER, never dollars",
    JSON.stringify(cards.map((c) => c.lineNumbers[0])) === JSON.stringify([...cards.map((c) => c.lineNumbers[0])].sort((a, b) => a - b)),
  );
  check("unmapped finding types render NO card", !cards.some((c) => c.findingType === "uncategorized_service") && !otherTrack.some((c) => c.findingType === "uncategorized_service"));
  check(
    "insurer-ground finding routes to otherTrack on a provider letter",
    otherTrack.some((c) => c.findingType === "zero_cost_share_overcharge") &&
      !cards.some((c) => c.findingType === "zero_cost_share_overcharge"),
  );
  check(
    "Andrew's helper wording pattern verbatim (duplicate)",
    cards.find((c) => c.findingType === "duplicate")?.helperLine ===
      "If you received this service once that day, not twice, this could be an error.",
  );
  check("line ref label singular", lineRefLabel([3]) === "bill line 3");
  check("line ref label pair", lineRefLabel([1, 2]) === "bill lines 1 & 2");
  check("claim-level = no ref", lineRefLabel([]) === null);
}

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
