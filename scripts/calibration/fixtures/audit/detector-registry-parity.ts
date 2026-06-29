/**
 * R3 step 2 — detector-registry-parity: proves DETECTOR_REGISTRY reproduces the pre-refactor
 * runAudit detector orchestration. DETERMINISTIC (no DB): structure + order, the `linesFiredBy`
 * skip-set computation, the F-14 skip WIRING end-to-end (F-14 is pure → crafted to fire), and the
 * sync detectors' wrapper arg-passing. The FULL integration byte-identity (incl. the async DB
 * detectors D13/D15/D4) is proven separately by runaudit-smoke.local.ts (hash 290c6b302295b340).
 * Run: npx tsx scripts/calibration/fixtures/audit/detector-registry-parity.ts
 */
import {
  DETECTOR_REGISTRY,
  linesFiredBy,
  type DetectorContext,
} from "../../../../src/lib/audit/detector-registry";
import {
  checkDuplicates,
  checkBalanceBilling,
  checkMissingAdjustments,
  type AuditRule,
} from "../../../../src/lib/audit/rules";
import type {
  AuditFinding,
  CMSPPLRate,
  FindingType,
  ParsedBill,
} from "../../../../src/lib/billing/types";
import type { PlanCoverageInput } from "../../../../src/lib/claims/recovery-math";
import type { AcaFallbackLineCoverageMap } from "../../../../src/lib/audit/coverage-loader";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  got=${JSON.stringify(got)}` : ""}`);
}

// The pre-refactor detector sequence (the old ALL_RULES loop + the 4 inline async calls, in order).
const EXPECTED_ORDER = [
  "overcharge",
  "duplicate",
  "balance_billing",
  "unbundling",
  "missing_adjustment",
  "zero_cost_share",
  "unallocated_balance",
  "insurance_underpayment",
  "description_match",
  "chargemaster",
];

// ── helpers ──────────────────────────────────────────────────────────────────
function makeBill(
  lineItems: ParsedBill["lineItems"],
  totals?: Partial<ParsedBill["totals"]>,
): ParsedBill {
  return {
    id: "p",
    documentId: "d",
    userId: "u",
    billType: "itemized_bill",
    provider: { name: "P" },
    patient: { name: "Q" },
    serviceDate: "2026-01-01",
    rawText: "",
    confidence: 1,
    parseErrors: [],
    lineItems,
    totals: { totalBilled: 0, ...totals },
  };
}
function ctx(over: Partial<DetectorContext>): DetectorContext {
  return {
    bill: makeBill([]),
    benchmarks: new Map<string, CMSPPLRate>(),
    chargemasterRates: new Map<string, number>(),
    planCoverage: null,
    acaFallback: null,
    priorFindings: [],
    ...over,
  };
}
function mkFinding(type: FindingType, lineItems: number[], over: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id: "f",
    type,
    severity: "medium",
    lineItems,
    title: "t",
    description: "d",
    estimatedOvercharge: 0,
    benchmarkSource: "s",
    billedAmount: 0,
    confidence: 1,
    actionable: true,
    ...over,
  };
}
const stable = (fs: AuditFinding[]) =>
  fs.map((f) => ({
    type: f.type,
    lineItems: [...f.lineItems].sort((a, b) => a - b),
    est: f.estimatedOvercharge,
    billed: f.billedAmount,
  }));
const entry = (key: string) => DETECTOR_REGISTRY.find((d) => d.key === key)!;
async function runEntry(key: string, c: DetectorContext) {
  return await entry(key).run(c);
}

async function main() {
  // ── P1 — completeness ──────────────────────────────────────────────────────
  {
    const keys = DETECTOR_REGISTRY.map((d) => d.key);
    check("P1 10 detectors", DETECTOR_REGISTRY.length === 10, keys);
    check("P1 keys unique", new Set(keys).size === 10);
  }

  // ── P2 — order == the pre-refactor sequence ────────────────────────────────
  {
    const keys = DETECTOR_REGISTRY.map((d) => d.key);
    check("P2 order == expected", keys.join(",") === EXPECTED_ORDER.join(","), keys);
  }

  // ── P3 — linesFiredBy: type filter + Array.isArray guard + multi-line ───────
  {
    const prior: AuditFinding[] = [
      mkFinding("zero_cost_share_overcharge", [3]),
      mkFinding("zero_cost_share_overcharge", [5, 7]),
      mkFinding("overcharge", [3]), // different type → must be ignored
      mkFinding("duplicate", [9]), // different type → must be ignored
    ];
    const set = linesFiredBy(prior, ["zero_cost_share_overcharge"]);
    check("P3 fires {3,5,7}", [...set].sort((a, b) => a - b).join(",") === "3,5,7", [...set]);
    check("P3 ignores other types (no 9)", !set.has(9));
    check("P3 empty prior → empty", linesFiredBy([], ["zero_cost_share_overcharge"]).size === 0);
    // The pre-refactor build had an `Array.isArray(f.lineItems) ? ... : []` guard — replicate it.
    const bad = [{ ...mkFinding("zero_cost_share_overcharge", []), lineItems: undefined as unknown as number[] }];
    check("P3 guards non-array lineItems", linesFiredBy(bad, ["zero_cost_share_overcharge"]).size === 0);
  }

  // ── P4 — F-14 skip WIRING end-to-end (F-14 is pure; craft it to fire on line N) ──
  {
    const N = 2;
    const aca: AcaFallbackLineCoverageMap = new Map<number, PlanCoverageInput>([
      [N, { covered: true, copay: 20, coinsurance: null }],
    ]);
    const bill = makeBill([
      {
        lineNumber: N,
        procedureCode: "99214",
        description: "Office visit",
        category: "office_visit",
        serviceDate: "2026-01-01",
        quantity: 1,
        billedAmount: 428,
        allowedAmount: 292.41,
        insurancePaid: 0,
        patientResponsibility: 292.41,
        ins_adjusted: 135.59,
      },
    ]);
    const noSkip = await runEntry("insurance_underpayment", ctx({ bill, acaFallback: aca, priorFindings: [] }));
    check(
      "P4 F-14 fires on line N when no prior zero_cost finding",
      noSkip.length === 1 && noSkip[0].lineItems[0] === N,
      stable(noSkip),
    );
    const skip = await runEntry(
      "insurance_underpayment",
      ctx({ bill, acaFallback: aca, priorFindings: [mkFinding("zero_cost_share_overcharge", [N])] }),
    );
    check("P4 F-14 SKIPS line N when prior zero_cost fired on it", skip.length === 0, stable(skip));
  }

  // ── P5 — sync detectors via registry == direct call (wrapper arg-passing) ───
  {
    const bill = makeBill([
      { lineNumber: 1, procedureCode: "AAA", description: "x", category: "c", serviceDate: "2026-01-01", quantity: 1, billedAmount: 100, patientResponsibility: 100 },
      { lineNumber: 2, procedureCode: "AAA", description: "x", category: "c", serviceDate: "2026-01-01", quantity: 1, billedAmount: 100, patientResponsibility: 100 }, // duplicate of line 1
      { lineNumber: 3, procedureCode: "BBB", description: "y", category: "c", serviceDate: "2026-01-02", quantity: 1, billedAmount: 650, allowedAmount: 500, insurancePaid: 300, patientResponsibility: 350 }, // balance_billing + missing_adjustment
    ]);
    const c = ctx({ bill });
    const pairs: Array<[string, AuditRule]> = [
      ["duplicate", checkDuplicates],
      ["balance_billing", checkBalanceBilling],
      ["missing_adjustment", checkMissingAdjustments],
    ];
    for (const [key, fn] of pairs) {
      const viaRegistry = await runEntry(key, c);
      const direct = fn(bill, c.benchmarks, null, null);
      check(
        `P5 ${key} registry == direct`,
        JSON.stringify(stable(viaRegistry)) === JSON.stringify(stable(direct)),
        { reg: stable(viaRegistry), dir: stable(direct) },
      );
    }
  }

  // ── P6 — declared deps + load-time ordering assertion ──────────────────────
  {
    const f14 = entry("insurance_underpayment");
    check(
      "P6 F-14 declares consumes zero_cost_share_overcharge",
      (f14.consumesFindingTypes ?? []).join(",") === "zero_cost_share_overcharge",
      f14.consumesFindingTypes,
    );
    // The module-load ordering assertion already executed on import (would throw if D13 came after
    // F-14); reaching here means it passed.
    check("P6 module ordering assertion passed (import succeeded)", true);
  }

  console.log(`\ndetector-registry-parity: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log(fails.join("\n"));
    process.exit(1);
  }
  console.log("ALL GREEN ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
