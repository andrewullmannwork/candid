/**
 * Fixture for the unmapped-line-items admin surface —
 * plans/unmapped_line_items_admin_fix.md (PR-1).
 *
 * CI-safe, pure-logic asserts on the grouping helpers the GET endpoint and the
 * pipeline UI rely on (no DB, no HTTP, no Haiku). The DB write-path proof
 * (proposeNewSignature → promote_with_slug → stamp → cacheLearnedMapping) runs
 * as the dev-clone E2E per the plan's Accuracy section — this fixture guards the
 * deterministic surface. Manually runnable per Ship Gate G4.
 *
 * Run: npx tsx scripts/admin-unmapped-fixture.ts
 */

import {
  groupUnmappedLineItems,
  unmappedGroupKey,
  isProcedureCodeType,
  UNMAPPED_GROUP_CAP,
  type UnmappedLineItemRow,
} from "../src/lib/admin/unmapped-line-items";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// The three real PROD items from the 2026-07-15 Slack alert (claim f0c9f094…)
const ndcRows: UnmappedLineItemRow[] = [
  { id: "a1", billing_code: "63323-486-02", billing_code_type: "NDC", description: "Lidocaine 2 % Soln (63323-486-02)" },
  { id: "a2", billing_code: "25021-608-20", billing_code_type: "NDC", description: "Propofol 10 Mg (25021-608-20)" },
  { id: "a3", billing_code: "0338-0117-04", billing_code_type: "NDC", description: "Lactated Ringers Soln (0338-0117-04)" },
];

console.log("\n— grouping: distinct codes stay distinct —");
{
  const groups = groupUnmappedLineItems(ndcRows);
  assert("3 distinct NDC rows → 3 groups", groups.length === 3, `got ${groups.length}`);
  assert("group carries code + type", groups.every((g) => g.billingCode !== null && g.billingCodeType === "NDC"));
  assert("each group count=1 with its id", groups.every((g) => g.count === 1 && g.lineItemIds.length === 1));
}

console.log("\n— grouping: identical lines collapse (peer coverage) —");
{
  const dup: UnmappedLineItemRow[] = [
    ...ndcRows,
    { id: "b1", billing_code: "25021-608-20", billing_code_type: "NDC", description: "Propofol 10 Mg (25021-608-20)" },
    { id: "b2", billing_code: "25021-608-20", billing_code_type: "NDC", description: "propofol 10 mg (25021-608-20)" }, // case-insensitive desc
  ];
  const groups = groupUnmappedLineItems(dup);
  assert("5 rows → 3 groups (dup code+desc collapses)", groups.length === 3, `got ${groups.length}`);
  const propofol = groups.find((g) => g.billingCode === "25021-608-20");
  assert("propofol group count=3 incl case-variant", propofol?.count === 3, `got ${propofol?.count}`);
  assert("propofol group is first (count-desc sort)", groups[0]?.billingCode === "25021-608-20");
  assert("all 3 line ids captured", propofol?.lineItemIds.length === 3);
}

console.log("\n— grouping: code-less rows group by description only —");
{
  const rows: UnmappedLineItemRow[] = [
    { id: "c1", billing_code: null, billing_code_type: null, description: "Facility fee" },
    { id: "c2", billing_code: null, billing_code_type: null, description: "Facility Fee" },
    { id: "c3", billing_code: null, billing_code_type: null, description: "Recovery room" },
  ];
  const groups = groupUnmappedLineItems(rows);
  assert("3 code-less rows → 2 groups", groups.length === 2, `got ${groups.length}`);
  assert("code-less group has null code fields", groups.every((g) => g.billingCode === null && g.billingCodeType === null));
  const ff = groups.find((g) => g.description.toLowerCase() === "facility fee");
  assert("facility-fee variants collapse", ff?.count === 2);
}

console.log("\n— grouping: hygiene —");
{
  const rows: UnmappedLineItemRow[] = [
    { id: "d1", billing_code: "99213", billing_code_type: "CPT", description: "   " },
    { id: "d2", billing_code: "99213", billing_code_type: "CPT", description: null },
    { id: "d3", billing_code: "99213", billing_code_type: null, description: "Office visit" }, // code without type → desc-keyed
  ];
  const groups = groupUnmappedLineItems(rows);
  assert("blank/null descriptions dropped", groups.length === 1, `got ${groups.length}`);
  assert("code-without-type falls back to desc key", groups[0]?.billingCode === null && groups[0]?.key.startsWith("desc:"));
  assert("cap respected on synthetic flood", groupUnmappedLineItems(
    Array.from({ length: 500 }, (_, i) => ({ id: `e${i}`, billing_code: `${10000 + i}`, billing_code_type: "CPT", description: `Service ${i}` })),
  ).length === UNMAPPED_GROUP_CAP);
}

console.log("\n— key stability (identity alignment) —");
{
  const k1 = unmappedGroupKey(ndcRows[1]);
  const k2 = unmappedGroupKey({ ...ndcRows[1], id: "zz", description: "PROPOFOL 10 MG (25021-608-20)" });
  assert("key is case-insensitive on description", k1 === k2);
  assert("key embeds code+type for coded rows", k1.startsWith("25021-608-20|NDC|"));
}

console.log("\n— code-type guard (mirrors mig 087 CHECK) —");
{
  assert("NDC accepted", isProcedureCodeType("NDC"));
  assert("CPT accepted", isProcedureCodeType("CPT"));
  assert("HCPCS_L2 accepted", isProcedureCodeType("HCPCS_L2"));
  assert("lowercase rejected", !isProcedureCodeType("ndc"));
  assert("unknown rejected", !isProcedureCodeType("ICD10"));
  assert("null/empty rejected", !isProcedureCodeType(null) && !isProcedureCodeType(""));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
