#!/usr/bin/env tsx
/**
 * S94 B4 — Bill parser hardening verification script.
 *
 * Pure-function regression tests for the three hardening primitives added
 * in this PR. Does NOT call Anthropic or hit Supabase — just exercises the
 * pure scan / plausibility / NaN-guard logic against the SBC fixture and
 * synthetic line-item shapes.
 *
 * Run from candid repo root:
 *   tsx scripts/s94-b4-bill-hardening-verify.ts
 *
 * Exit code 0 = all pass; non-zero = at least one assertion failed.
 *
 * For end-to-end verification (parser actually rejects when flag ON), see
 * the Chrome MCP test plan in the PR description: upload the same SBC
 * fixture via the document picker and confirm no claim is created.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { scanForSbcMarkers } from "../src/lib/billing/sbc-marker-scan";
import { lineIsImplausible } from "../src/lib/billing/line-plausibility";
import type { BillLineItem } from "../src/lib/billing/types";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? `\n     ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

// ============================================================================
// Section A — SBC marker scan against the actual failing fixture
// ============================================================================
section("A. SBC marker scan (Fix #1b)");

const sbcText = readFileSync(
  join(__dirname, "..", "tests", "fixtures", "sbcs", "ambetter-ca-2024-bronze-60-hdhp", "source.txt"),
  "utf8",
);
const sbcScan = scanForSbcMarkers(sbcText);
check(
  "Ambetter Bronze 60 SBC fixture is detected as SBC",
  sbcScan.isLikelySbc,
  `matched: ${sbcScan.matchedMarkers.join(", ")}`,
);
check(
  "Matches at least 5 SBC markers (high-confidence detection)",
  sbcScan.matchedMarkers.length >= 5,
  `got ${sbcScan.matchedMarkers.length} of ${sbcScan.totalMarkersChecked}`,
);
check(
  "Includes 'title' marker (Summary of Benefits and Coverage)",
  sbcScan.matchedMarkers.includes("title"),
);
check(
  "Includes 'common_medical_event' marker (table header)",
  sbcScan.matchedMarkers.includes("common_medical_event"),
);
check(
  "Includes 'coverage_examples_header' marker (Peg/Joe/Mia section)",
  sbcScan.matchedMarkers.includes("coverage_examples_header"),
);

// Negative test: a real EOB-shaped string should NOT match
const realEobText = `
Patient: Jane Doe
Member ID: ABC123456
Service Date: 03/15/2026
Claim Number: CLM00123456

Line  Date     Description           Code   Billed   Allowed   Plan Paid   Patient Owes
1     03/15/26 Office visit          99213  $200.00  $80.00    $50.00      $30.00
2     03/15/26 Lab venipuncture      36415  $25.00   $10.00    $0.00       $10.00

Total billed: $225.00   Plan paid: $50.00   You owe: $40.00

Notes:
B1 - PATIENT COPAY APPLIED PER PLAN BENEFIT
`;
const realEobScan = scanForSbcMarkers(realEobText);
check(
  "Real EOB text is NOT misidentified as SBC",
  !realEobScan.isLikelySbc,
  `matched: ${realEobScan.matchedMarkers.join(", ") || "(none)"}`,
);

// Negative test: empty string
const emptyScan = scanForSbcMarkers("");
check(
  "Empty string is NOT detected as SBC",
  !emptyScan.isLikelySbc,
);

// Edge: single-marker hit should NOT trigger (requires ≥2)
const singleMarkerText = "This document references the Summary of Benefits and Coverage from your previous plan.";
const singleScan = scanForSbcMarkers(singleMarkerText);
check(
  "Single-marker mention does NOT trigger detection (requires >=2)",
  !singleScan.isLikelySbc,
  `matched: ${singleScan.matchedMarkers.join(", ")}`,
);

// ============================================================================
// Section B — Line plausibility check (Fix #3)
// ============================================================================
section("B. Line plausibility (Fix #3) — exercises against the actual hallucinated lines");

// Reproduces the 5 hallucinated lines from claim 52c1f432 (deleted; per
// briefing). Each should be dropped by lineIsImplausible.
function makeLine(billed: number, paid: number | undefined, owed: number | undefined, code = "X"): BillLineItem {
  return {
    lineNumber: 1,
    procedureCode: code,
    procedureCodeType: "CPT",
    description: "test",
    category: "test",
    serviceDate: "2026-05-15",
    quantity: 1,
    billedAmount: billed,
    insurancePaid: paid,
    patientResponsibility: owed,
  };
}

// Hallucinated line 1: billed=$0, owed=$91,410
check(
  "Drops hallucinated line: billed=$0, owed=$91,410 (from coverage example math)",
  lineIsImplausible(makeLine(0, undefined, 91410, "10348")).dropped,
);

// Hallucinated line 3: billed=$10,348, paid=$91,410 (insurer paid 8.8x billed)
check(
  "Drops hallucinated line: billed=$10,348, paid=$91,410 (paid 8.8x billed)",
  lineIsImplausible(makeLine(10348, 91410, 348, "10348")).dropped,
);

// Hallucinated line 4: billed=$0, owed=$509 (under threshold — escapes)
check(
  "Allows: billed=$0, owed=$509 (under $5k allocation threshold) — caught downstream",
  !lineIsImplausible(makeLine(0, undefined, 509, "20201")).dropped,
);

// Hallucinated line 5: billed=$711, paid=$26, owed=$888 (owed > billed by 25%, paid is fine)
check(
  "Allows: billed=$711, paid=$26, owed=$888 (owed only 1.25x billed — under 20x threshold)",
  !lineIsImplausible(makeLine(711, 26, 888, "51330")).dropped,
);

// Real-world bill: should NOT be dropped
check(
  "Real bill: $200 billed / $50 paid / $30 owed — kept",
  !lineIsImplausible(makeLine(200, 50, 30)).dropped,
);

// Real-world bill: capitated visit with $0 billed + $20 copay — should be kept
check(
  "Capitated visit: $0 billed / $0 paid / $20 owed — kept (under threshold)",
  !lineIsImplausible(makeLine(0, 0, 20)).dropped,
);

// Real-world bill: secondary payer covered most — should be kept
check(
  "Secondary payer scenario: $200 billed / $180 paid / $0 owed — kept (paid only 0.9x billed)",
  !lineIsImplausible(makeLine(200, 180, 0)).dropped,
);

// Real-world bill: small copay-only line — should be kept
check(
  "Real bill: $50 billed / $0 paid / $50 owed — kept (owed = 1x billed)",
  !lineIsImplausible(makeLine(50, 0, 50)).dropped,
);

// Real-world bill: undefined money fields — should be kept (no money to compare)
check(
  "Undefined money fields: kept (no plausibility violation)",
  !lineIsImplausible(makeLine(100, undefined, undefined)).dropped,
);

// Edge: insurance paid exactly 5x billed (boundary, strict greater-than)
check(
  "Boundary: paid = 5x billed exactly — kept (strict greater-than)",
  !lineIsImplausible(makeLine(100, 500, 0)).dropped,
);

// Edge: insurance paid 5.01x billed (just over boundary)
check(
  "Boundary: paid = 5.01x billed — dropped",
  lineIsImplausible(makeLine(100, 501, 0)).dropped,
);

// Realistic interest scenario: paid 1.5x billed — kept
check(
  "Realistic: paid = 1.5x billed (interest/penalty scenario) — kept",
  !lineIsImplausible(makeLine(100, 150, 0)).dropped,
);

// ============================================================================
// Section C — NaN guard logic (Fix #4) — pure check on Number.isFinite predicate
// ============================================================================
section("C. NaN guard predicate (Fix #4) — sanity check on filter logic");

// The actual filter is in audit/index.ts; here we just verify the
// Number.isFinite predicate behaves as expected for the leak vectors:
check("Number.isFinite(NaN) === false", !Number.isFinite(NaN));
check("Number.isFinite(Infinity) === false", !Number.isFinite(Infinity));
check("Number.isFinite(-Infinity) === false", !Number.isFinite(-Infinity));
check("Number.isFinite(0) === true", Number.isFinite(0));
check("Number.isFinite(91410) === true", Number.isFinite(91410));
check("Number.isFinite(undefined) === false (filter rejects undefined)", !Number.isFinite(undefined as unknown as number));

// ============================================================================
// Summary
// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
