/**
 * litigation-hold — S326 eleven-rules Rule 8 (the kill-switch's litigation slice).
 *
 * Proves: (1) an attested lawsuit refuses EVERY letter type (the unflagged
 * legal gate; litigation outranks geo + tier); (2) `false`/`null` leave every
 * prior behavior untouched (null = legacy unanswered → inert; the geo gate
 * still governs negotiation); (3) the escalate gate refuses on hold; (4) the
 * step-id constant is pinned (the checklist key the loader + UI both read).
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/litigation-hold.ts
 */
import {
  evaluateLetterAccess,
  LITIGATION_HOLD_MESSAGE,
  LITIGATION_STEP_ID,
} from "../../../../src/lib/disputes/letter-access";
import { checkEscalateGate } from "../../../../src/lib/disputes/escalate-gate";
import type { DisputeLetterType } from "../../../../src/lib/billing/types";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

const ALL_TYPES: DisputeLetterType[] = [
  "insurance_appeal",
  "external_review",
  "overcharge",
  "duplicate_charge",
  "balance_billing",
  "itemized_request",
  "final_notice",
  "negotiation",
  "debt_validation",
];

// 1 — attested-yes refuses EVERY type (even with Pro, even outside CA).
for (const t of ALL_TYPES) {
  const r = evaluateLetterAccess({
    letterType: t,
    isPro: true,
    userState: "WA",
    litigationAttested: true,
  });
  check(`${t} refused under litigation hold`, !r.allowed && r.reason === "litigation_hold");
}

// 2 — litigation outranks geo: a CA negotiation under hold reports the HOLD.
{
  const r = evaluateLetterAccess({
    letterType: "negotiation",
    isPro: false,
    userState: "CA",
    litigationAttested: true,
  });
  check("hold outranks geo (reason is litigation_hold, not geo)", r.reason === "litigation_hold");
}

// 3 — false / null leave prior behavior untouched.
for (const answered of [false, null] as const) {
  const free = evaluateLetterAccess({
    letterType: "overcharge",
    isPro: false,
    userState: null,
    litigationAttested: answered,
  });
  check(`overcharge allowed with litigationAttested=${String(answered)}`, free.allowed);
  const geo = evaluateLetterAccess({
    letterType: "negotiation",
    isPro: false,
    userState: "CA",
    litigationAttested: answered,
  });
  check(
    `negotiation + CA still geo-refused with litigationAttested=${String(answered)}`,
    !geo.allowed && geo.reason === "geo_unavailable",
  );
}

// 4 — the escalate gate refuses on hold (every rung).
{
  const r = checkEscalateGate({
    targetLetterType: "final_notice",
    isPro: true,
    litigationAttested: true,
  });
  check("escalate refused under hold", !r.ok && r.status === 403 && r.error === "litigation_hold");
  const ok = checkEscalateGate({
    targetLetterType: "final_notice",
    isPro: true,
    litigationAttested: null,
  });
  check("escalate unaffected when unanswered", ok.ok);
}

// 5 — pinned constants (the checklist key + the copy's core promise words).
check("step id pinned", LITIGATION_STEP_ID === "screening:litigation");
check(
  "hold message says it needs a lawyer, plainly",
  LITIGATION_HOLD_MESSAGE.includes("needs a lawyer"),
);

console.log(`\nlitigation-hold: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
