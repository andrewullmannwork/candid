/**
 * S73.5 D6 — Plan-year validity window tests.
 *
 * Validates Subplan §2.10 plan-year-aware document routing scenarios.
 *
 * Run: `npx tsx scripts/test-year-validity-window.ts`
 */

import {
  computeValidityWindow,
  isWithinValidityWindow,
  decideValidityRouting,
  isWithinAbsoluteAge,
} from "@/lib/plan/year-validity-window";

let pass = 0;
let fail = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("\n=== S73.5 D6: Plan-year validity window ===\n");

// ── 1. computeValidityWindow basic ───────────────────────────────────────────
console.log("[1] computeValidityWindow(2026)");
const w2026 = computeValidityWindow(2026);
assert(
  w2026.windowStart.toISOString() === "2025-07-01T00:00:00.000Z",
  `windowStart === 2025-07-01 (got ${w2026.windowStart.toISOString()})`,
);
assert(
  w2026.windowEnd.toISOString() === "2028-06-30T23:59:59.999Z",
  `windowEnd === 2028-06-30 23:59:59.999 (got ${w2026.windowEnd.toISOString()})`,
);
assert(w2026.planYear === 2026, "planYear echo");

console.log("\n[2] computeValidityWindow(2024)");
const w2024 = computeValidityWindow(2024);
assert(
  w2024.windowStart.toISOString() === "2023-07-01T00:00:00.000Z",
  `2024 windowStart === 2023-07-01`,
);
assert(
  w2024.windowEnd.toISOString() === "2026-06-30T23:59:59.999Z",
  `2024 windowEnd === 2026-06-30`,
);

// ── 2. Subplan §2.10 scenario table ──────────────────────────────────────────
console.log("\n[3] Subplan §2.10 scenario table");

// Scenario 1: 2024 SBC uploaded May 2024 → in 2024 window
assert(
  isWithinValidityWindow(new Date("2024-05-15T00:00:00Z"), 2024) === true,
  "2024 SBC uploaded May 2024 → within window",
);

// Scenario 2: 2024 SBC uploaded May 2026 → within 2024 valid_window (ends Jun 2026)
assert(
  isWithinValidityWindow(new Date("2026-05-15T00:00:00Z"), 2024) === true,
  "2024 SBC uploaded May 2026 → within 2024 historical window",
);

// Scenario 3: 2024 SBC uploaded Sep 2026 → past 2024 valid_window
assert(
  isWithinValidityWindow(new Date("2026-09-15T00:00:00Z"), 2024) === false,
  "2024 SBC uploaded Sep 2026 → past 2024 window (Jun 2026 end)",
);

// Scenario 4: 2026 SBC uploaded Jan 2026 → in 2026 window
assert(
  isWithinValidityWindow(new Date("2026-01-15T00:00:00Z"), 2026) === true,
  "2026 SBC uploaded Jan 2026 → within window",
);

// Scenario 5: doc with no extractable plan_year → not within (caller falls back)
assert(
  isWithinValidityWindow(new Date("2026-01-15T00:00:00Z"), null) === false,
  "null plan_year → false (caller must fall back)",
);

// ── 3. Open-enrollment edge: upload right at windowStart inclusive ──────────
console.log("\n[4] Open-enrollment boundary inclusivity");
// plan_year=2026 → windowStart = 2025-07-01 00:00 UTC (inclusive)
assert(
  isWithinValidityWindow(new Date("2025-07-01T00:00:00.000Z"), 2026) === true,
  "uploadedAt == windowStart exactly → in window (inclusive)",
);
assert(
  isWithinValidityWindow(new Date("2025-06-30T23:59:59.999Z"), 2026) === false,
  "uploadedAt 1ms before windowStart → out of window",
);
// windowEnd 2028-06-30 23:59:59.999Z inclusive
assert(
  isWithinValidityWindow(new Date("2028-06-30T23:59:59.999Z"), 2026) === true,
  "uploadedAt == windowEnd exactly → in window (inclusive)",
);
assert(
  isWithinValidityWindow(new Date("2028-07-01T00:00:00.000Z"), 2026) === false,
  "uploadedAt 1ms past windowEnd → out of window",
);

// ── 4. decideValidityRouting ─────────────────────────────────────────────────
console.log("\n[5] decideValidityRouting()");
const r1 = decideValidityRouting(new Date("2026-05-15T00:00:00Z"), 2026);
assert(r1.decision === "route_to_canonical", "current-year SBC → route_to_canonical");
if (r1.decision === "route_to_canonical") {
  assert(r1.planYear === 2026, "route_to_canonical planYear === 2026");
}

const r2 = decideValidityRouting(new Date("2026-09-15T00:00:00Z"), 2024);
assert(r2.decision === "historical_only", "stale 2024 SBC → historical_only");
if (r2.decision === "historical_only") {
  assert(r2.reason === "past_window", "historical_only reason === past_window");
}

const r3 = decideValidityRouting(new Date("2025-06-01T00:00:00Z"), 2026);
assert(r3.decision === "historical_only", "uploaded too early (before window) → historical_only");
if (r3.decision === "historical_only") {
  assert(r3.reason === "before_window", "historical_only reason === before_window");
}

const r4 = decideValidityRouting(new Date("2026-05-15T00:00:00Z"), null);
assert(
  r4.decision === "fallback_absolute_age",
  "missing planYear → fallback_absolute_age",
);
if (r4.decision === "fallback_absolute_age") {
  assert(r4.reason === "missing_plan_year", "fallback reason === missing_plan_year");
}

const r5 = decideValidityRouting(null, 2026);
assert(r5.decision === "fallback_absolute_age", "missing uploadedAt → fallback");

const r6 = decideValidityRouting("not-a-date", 2026);
assert(
  r6.decision === "fallback_absolute_age",
  "invalid uploadedAt string → fallback",
);

// ── 5. isWithinAbsoluteAge legacy fallback ──────────────────────────────────
console.log("\n[6] isWithinAbsoluteAge() legacy fallback");
const now = new Date("2026-05-11T00:00:00Z");
assert(
  isWithinAbsoluteAge(new Date("2026-01-01T00:00:00Z"), now, 12) === true,
  "4 months ago → within 12-month absolute age",
);
assert(
  isWithinAbsoluteAge(new Date("2025-06-01T00:00:00Z"), now, 12) === true,
  "11 months ago → within 12-month absolute age",
);
assert(
  isWithinAbsoluteAge(new Date("2025-04-01T00:00:00Z"), now, 12) === false,
  "13 months ago → outside 12-month absolute age",
);
assert(
  isWithinAbsoluteAge(null, now, 12) === false,
  "null uploadedAt → false",
);

// Summary
console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);
