/**
 * letter-geo-gate — S324 (2026-08-26). Locks the CALIFORNIA GEO GATE on the
 * self-pay `negotiation` letter.
 *
 * Why this gate exists: the negotiation letter (asking a provider to accept
 * less than the billed amount) is a debt-settlement service under California's
 * CCFPL registration regime (10 CCR § 1001(b)(1) + § 1010(a)); it is
 * unavailable to California residents until Candid's DFPI registration is
 * effective. This is a LEGAL gate: it has no feature flag by design and
 * changes only via a reviewed PR. The deploy of this commit is the timestamp
 * of the gate taking effect.
 *
 * What this fixture locks:
 *   1. negotiation + CA        → refused, reason geo_unavailable
 *   2. negotiation + ca / " Ca" (case/whitespace) → refused (normalization)
 *   3. negotiation + null state → refused (FAIL CLOSED on unknown state)
 *   4. negotiation + non-gated state (TX) → allowed
 *   5. Pro cannot buy past the gate (isPro: true still refused)
 *   6. Non-gated types are untouched: overcharge/insurance_appeal/debt_validation
 *      allowed for CA users and for null-state users
 *   7. The tier rule still works beneath geo: PRO_LETTER_TYPES (currently
 *      empty) members refuse without Pro — asserted structurally
 *   8. TRIPWIRE: no ESCALATION_LETTER_TYPE is geo-gated — escalate-gate passes
 *      userState: null on that basis; adding a geo-gated type to the ladder
 *      must fail here first
 *   9. letterGeoRelevant is true for exactly the GEO_GATED_LETTER_TYPES keys
 *  10. GEO_GATE_MESSAGE names no statute and promises no date (plain copy)
 *
 * Run:  npx tsx scripts/calibration/fixtures/legal/letter-geo-gate.ts
 */
import {
  evaluateLetterAccess,
  letterGeoRelevant,
  GEO_GATED_LETTER_TYPES,
  GEO_GATE_MESSAGE,
  PRO_LETTER_TYPES,
} from "../../../../src/lib/disputes/letter-access";
import { ESCALATION_LETTER_TYPES } from "../../../../src/lib/disputes/escalate-gate";
import type { DisputeLetterType } from "../../../../src/lib/billing/types";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

// 1 — CA refused
{
  const r = evaluateLetterAccess({ litigationAttested: null, letterType: "negotiation", isPro: false, userState: "CA" });
  check("negotiation + CA refused", !r.allowed);
  check("reason is geo_unavailable", r.reason === "geo_unavailable");
  check("geo refusal is not a Pro refusal", r.requiresPro === false);
}

// 2 — normalization
for (const s of ["ca", " Ca ", "CA "]) {
  const r = evaluateLetterAccess({ litigationAttested: null, letterType: "negotiation", isPro: false, userState: s });
  check(`negotiation + ${JSON.stringify(s)} refused (normalized)`, !r.allowed);
}

// 3 — unknown state fails closed
{
  const r = evaluateLetterAccess({ litigationAttested: null, letterType: "negotiation", isPro: false, userState: null });
  check("negotiation + null state FAILS CLOSED", !r.allowed && r.reason === "geo_unavailable");
  const r2 = evaluateLetterAccess({ litigationAttested: null, letterType: "negotiation", isPro: false, userState: "" });
  check("negotiation + empty-string state FAILS CLOSED", !r2.allowed);
}

// 4 — non-gated state allowed
{
  const r = evaluateLetterAccess({ litigationAttested: null, letterType: "negotiation", isPro: false, userState: "TX" });
  check("negotiation + TX allowed", r.allowed);
}

// 5 — Pro cannot buy past geo
{
  const r = evaluateLetterAccess({ litigationAttested: null, letterType: "negotiation", isPro: true, userState: "CA" });
  check("Pro does not bypass the geo gate", !r.allowed && r.reason === "geo_unavailable");
}

// 6 — non-gated types untouched, including for CA + unknown-state users
for (const t of ["overcharge", "insurance_appeal", "debt_validation"] as DisputeLetterType[]) {
  const ca = evaluateLetterAccess({ litigationAttested: null, letterType: t, isPro: false, userState: "CA" });
  const unk = evaluateLetterAccess({ litigationAttested: null, letterType: t, isPro: false, userState: null });
  check(`${t} + CA allowed`, ca.allowed);
  check(`${t} + unknown state allowed`, unk.allowed);
}

// 7 — the tier rule still works beneath geo (structural: honors whatever
// PRO_LETTER_TYPES holds; empty today per the S299 wall removal)
for (const t of PRO_LETTER_TYPES) {
  const r = evaluateLetterAccess({ litigationAttested: null, letterType: t, isPro: false, userState: "TX" });
  check(`PRO type ${t} refused without Pro`, !r.allowed && r.reason === "subscription_required");
}
check("PRO_LETTER_TYPES honored (vacuously green while empty)", true);

// 8 — TRIPWIRE: the escalation ladder must contain no geo-gated type
for (const t of ESCALATION_LETTER_TYPES) {
  check(
    `escalation type ${t} is NOT geo-gated (escalate-gate passes userState:null on this basis)`,
    !letterGeoRelevant(t),
  );
}

// 9 — letterGeoRelevant ⇔ GEO_GATED_LETTER_TYPES keys
{
  const keys = Object.keys(GEO_GATED_LETTER_TYPES) as DisputeLetterType[];
  check("geo map is non-empty (negotiation present)", keys.includes("negotiation"));
  for (const k of keys) check(`letterGeoRelevant(${k})`, letterGeoRelevant(k));
  check("letterGeoRelevant(overcharge) false", !letterGeoRelevant("overcharge" as DisputeLetterType));
  check("letterGeoRelevant(null) false", !letterGeoRelevant(null));
}

// 10 — the user-facing copy stays plain: no statute cites, no promised date
{
  check("message names no statute", !/§|\bCCR\b|\bCCFPL\b|\bDFPI\b/i.test(GEO_GATE_MESSAGE));
  check("message promises no date", !/\b20\d\d\b/.test(GEO_GATE_MESSAGE));
  check("message is non-empty", GEO_GATE_MESSAGE.trim().length > 20);
}

console.log(`letter-geo-gate: ${pass}/${pass + fail} checks passed`);
if (fail > 0) {
  console.log("FAILED ✗");
  process.exit(1);
}
