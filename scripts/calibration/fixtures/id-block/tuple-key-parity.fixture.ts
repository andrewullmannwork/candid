/**
 * ID-Block PR3c tuple-key-parity fixture (Ship Gate G4 — cross-module invariant).
 *
 * The re-eval tuple-drift guard (apply-confirmed-promotion.ts) compares a held row's
 * value_tuple_key — produced by id-block/gate.ts `tupleKey` — against
 * `identityKey(currentBaselineTuple)` from cf40-v4/doctype-promotion-aggregator.ts. The
 * guard is only sound if the two keyers produce IDENTICAL strings for the same tuple.
 * Both claim to mirror SUPERMAJORITY_IDENTITY_FIELDS; this fixture LOCKS that agreement
 * over the real domain (the 4 cost scalars, each number | null) so any future divergence
 * (a renamed/reordered field, a different null sentinel) fails loudly here.
 *
 * Run:
 *   cd /Users/andrewullmann/Desktop/candid
 *   npx tsx scripts/calibration/fixtures/id-block/tuple-key-parity.fixture.ts
 *
 * Pass criteria: tupleKey(t) === identityKey(t) for every tuple. Exit 0 PASS / 1 FAIL.
 */

import { tupleKey } from "../../../../src/lib/parser/id-block/gate";
import { identityKey } from "../../../../src/lib/parser/cf40-v4/doctype-promotion-aggregator";

type Tuple = {
  in_deductible_individual: number | null;
  in_deductible_family: number | null;
  in_oop_max_individual: number | null;
  in_oop_max_family: number | null;
};

const tuples: { name: string; t: Tuple }[] = [
  {
    name: "all numbers",
    t: { in_deductible_individual: 1000, in_deductible_family: 2000, in_oop_max_individual: 5000, in_oop_max_family: 10000 },
  },
  {
    name: "zeros (must be distinct from null)",
    t: { in_deductible_individual: 0, in_deductible_family: 0, in_oop_max_individual: 0, in_oop_max_family: 0 },
  },
  {
    name: "all nulls",
    t: { in_deductible_individual: null, in_deductible_family: null, in_oop_max_individual: null, in_oop_max_family: null },
  },
  {
    name: "mixed null/number/zero",
    t: { in_deductible_individual: 1500, in_deductible_family: 0, in_oop_max_individual: null, in_oop_max_family: 7500 },
  },
  {
    name: "partial nulls",
    t: { in_deductible_individual: 0, in_deductible_family: null, in_oop_max_individual: 8000, in_oop_max_family: null },
  },
];

let failed = 0;
for (const { name, t } of tuples) {
  const gateKey = tupleKey(t as unknown as Record<string, unknown>);
  const aggKey = identityKey(t);
  const ok = gateKey === aggKey;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  [gate="${gateKey}" agg="${aggKey}"]`}`);
  if (!ok) failed++;
}
console.log(`\n${tuples.length - failed}/${tuples.length} passed`);
process.exit(failed === 0 ? 0 : 1);
