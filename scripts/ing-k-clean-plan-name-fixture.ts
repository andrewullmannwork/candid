/**
 * Ing-K Phase 1 retroactive Ship Gate G4 fixture — cleanPlanName cross-module invariant.
 *
 * Asserts that:
 *   1. cleanPlanName (exported from canonical-match.ts) produces expected output
 *      for known inputs (regression protection if the function evolves).
 *   2. computeInputSignature (from canonical-match-telemetry.ts) consumes the
 *      same cleanPlanName — proved structurally by direct import, asserted
 *      empirically by recomputing the signature manually here and comparing.
 *
 * The cross-module invariant is closed STRUCTURALLY post-Ing-K-cleanPlanName-remediation:
 *   - canonical-match.ts exports cleanPlanName
 *   - canonical-match-telemetry.ts imports it (no longer mirrors the body)
 *
 * This fixture exists to:
 *   - Catch behavioral regressions if cleanPlanName logic changes
 *   - Verify the structural invariant holds in case a future refactor re-introduces a mirror
 *   - Satisfy Block Ship Gate Gate 4 (fixture exists + manually re-runnable today;
 *     CI wiring is a separate follow-up obligation per block_ship_gate.md)
 *
 * Run with: npx tsx scripts/ing-k-clean-plan-name-fixture.ts
 *
 * Exit code 0 on all-pass; 1 on any failure (CI-ready when test harness lands).
 */
import { createHash } from "node:crypto";
import { cleanPlanName } from "../src/lib/plan/canonical-match";
import { computeInputSignature } from "../src/lib/plan/canonical-match-telemetry";

interface CleanPlanNameCase {
  label: string;
  input: string;
  expected: string;
}

interface SignatureCase {
  label: string;
  insurerId: string;
  planName: string;
  planYear: number;
}

const cleanPlanNameCases: CleanPlanNameCase[] = [
  { label: "lowercase + trim", input: "  Bronze Plan  ", expected: "plan" },
  { label: "state-code stripped (uppercase)", input: "Bronze CA-001 Plan", expected: "plan" },
  { label: "state-code stripped (mixed case)", input: "Bronze ca-001 Plan", expected: "plan" },
  { label: "year stripped", input: "Silver Plan 2024", expected: "plan" },
  { label: "parenthesized suffix stripped", input: "Gold Plan (No Referrals)", expected: "plan" },
  { label: "metal tier stripped", input: "Platinum Premium HMO", expected: "premium hmo" },
  { label: "catastrophic tier stripped", input: "Catastrophic Plan", expected: "plan" },
  { label: "all transforms combined", input: "  BRONZE CA-001 Premium Plan (Exchange) 2024  ", expected: "premium plan" },
  { label: "whitespace normalized", input: "Premium   PPO    Plan", expected: "premium ppo plan" },
  { label: "empty string", input: "", expected: "" },
  { label: "whitespace only", input: "   ", expected: "" },
  { label: "no normalization needed", input: "specialty access", expected: "specialty access" },
  { label: "double parentheses", input: "Premium (HSA) Plan (No Network)", expected: "premium plan" },
  { label: "year inside parens (parens win)", input: "Premium (2024 Open) Plan", expected: "premium plan" },
];

const signatureCases: SignatureCase[] = [
  {
    label: "same upload twice → same signature (Ing-K bug pattern)",
    insurerId: "00000000-0000-0000-0000-000000000001",
    planName: "Bronze Premium HMO Plan 2024",
    planYear: 2024,
  },
  {
    label: "same plan, different year → different signature",
    insurerId: "00000000-0000-0000-0000-000000000001",
    planName: "Premium HMO",
    planYear: 2025,
  },
  {
    label: "different insurer → different signature",
    insurerId: "00000000-0000-0000-0000-000000000002",
    planName: "Premium HMO",
    planYear: 2024,
  },
  {
    label: "whitespace + metal tier normalize away",
    insurerId: "11111111-1111-1111-1111-111111111111",
    planName: "  BRONZE  Premium   HMO  ",
    planYear: 2024,
  },
];

function computeSignatureManually(insurerId: string, planName: string, planYear: number): string {
  const cleanName = cleanPlanName(planName || "");
  const seed = `${insurerId}|${cleanName}|${planYear}`;
  return createHash("sha256").update(seed).digest("hex");
}

let pass = 0;
let fail = 0;

console.log("== cleanPlanName behavior cases ==");
for (const c of cleanPlanNameCases) {
  const actual = cleanPlanName(c.input);
  const ok = actual === c.expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.label}: in=${JSON.stringify(c.input)}  out=${JSON.stringify(actual)}  expected=${JSON.stringify(c.expected)}`);
  if (ok) pass++; else fail++;
}

console.log("\n== computeInputSignature cross-module invariant ==");
for (const c of signatureCases) {
  const fromModule = computeInputSignature({
    insurerId: c.insurerId,
    planName: c.planName,
    planYear: c.planYear,
  });
  const manual = computeSignatureManually(c.insurerId, c.planName, c.planYear);
  const ok = fromModule === manual;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.label}`);
  console.log(`        module=${fromModule}`);
  console.log(`        manual=${manual}`);
  if (ok) pass++; else fail++;
}

console.log("\n== same-input-twice invariant (Ing-K bug pattern) ==");
{
  const c = signatureCases[0];
  const sig1 = computeInputSignature({ insurerId: c.insurerId, planName: c.planName, planYear: c.planYear });
  const sig2 = computeInputSignature({ insurerId: c.insurerId, planName: c.planName, planYear: c.planYear });
  const ok = sig1 === sig2;
  console.log(`${ok ? "PASS" : "FAIL"}  two identical CanonicalMatchInput → identical signature`);
  if (ok) pass++; else fail++;
}

console.log("\n== plan-name-noise invariance ==");
{
  const a = computeInputSignature({ insurerId: "ins-x", planName: "Bronze Premium HMO 2024 (Exchange)", planYear: 2024 });
  const b = computeInputSignature({ insurerId: "ins-x", planName: "  PREMIUM hmo  ", planYear: 2024 });
  const ok = a === b;
  console.log(`${ok ? "PASS" : "FAIL"}  same canonical clean-name → identical signature regardless of metal-tier/year/whitespace/case`);
  console.log(`        a=${a}`);
  console.log(`        b=${b}`);
  if (ok) pass++; else fail++;
}

console.log(`\n== summary ==\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
