/**
 * escalate-gating — dispute-letters v2 Zone-3 (S266) unit fixture.
 *
 * Locks the escalate route's guard (allowlist + tier + exhaustion) so the
 * ladder-advance path can't become a laxer bypass than /api/disputes/generate.
 *
 * Run:  npx tsx scripts/calibration/fixtures/dispute-grounds/escalate-gating.ts
 */
import {
  checkEscalateGate,
  isEscalationLetterType,
  ESCALATION_LETTER_TYPES,
} from "../../../../src/lib/disputes/escalate-gate";
import {
  evaluateLetterAccess,
  letterRequiresPro,
} from "../../../../src/lib/disputes/letter-access";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (${String(got)})` : ""}`);
}

// ── allowlist ────────────────────────────────────────────────────────────────
check("allowlist · has exactly 3 types", ESCALATION_LETTER_TYPES.length === 3, ESCALATION_LETTER_TYPES.length);
check("allowlist · external_review", isEscalationLetterType("external_review"));
check("allowlist · final_notice", isEscalationLetterType("final_notice"));
check("allowlist · debt_validation", isEscalationLetterType("debt_validation"));
check("allowlist · rejects insurance_appeal (first-contact)", !isEscalationLetterType("insurance_appeal"));
check("allowlist · rejects overcharge", !isEscalationLetterType("overcharge"));
check("allowlist · rejects junk", !isEscalationLetterType("lawyer_referral"));
check("allowlist · rejects null", !isEscalationLetterType(null));

// ── unsupported type → 400 ───────────────────────────────────────────────────
{
  const r = checkEscalateGate({ targetLetterType: "overcharge", isPro: true });
  check("unsupported · 400 unsupported_escalation_type", !r.ok && r.status === 400 && r.error === "unsupported_escalation_type");
}

// ── tier gate: final_notice / external_review require Pro ─────────────────────
// S299 (Andrew): the escalation Pro wall is REMOVED — PRO_LETTER_TYPES is
// empty, so free users pass the tier gate on every rung. The gate MACHINERY
// stays (these checks prove the flow-through); restoring the wall = re-adding
// the types in letter-access.ts, at which point these expectations flip back.
{
  const r = checkEscalateGate({ targetLetterType: "final_notice", isPro: false });
  check("tier · final_notice free-user → ok (wall removed S299)", r.ok === true);
}
{
  const r = checkEscalateGate({ targetLetterType: "external_review", isPro: false, appealExhausted: { attested: true } });
  check("tier · external_review free-user + exhaustion → ok (wall removed S299)", r.ok === true);
}
{
  const r = checkEscalateGate({ targetLetterType: "final_notice", isPro: true });
  check("tier · final_notice Pro → ok", r.ok === true);
}

// ── debt_validation is FREE (no Pro required) ────────────────────────────────
{
  const r = checkEscalateGate({ targetLetterType: "debt_validation", isPro: false });
  check("free · debt_validation free-user → ok", r.ok === true);
}

// ── exhaustion gate: external_review needs an attested final denial ───────────
{
  const r = checkEscalateGate({ targetLetterType: "external_review", isPro: true, appealExhausted: null });
  check("exhaustion · no attestation → 400", !r.ok && r.status === 400 && r.error === "external_review_requires_exhaustion");
}
{
  const r = checkEscalateGate({ targetLetterType: "external_review", isPro: true, appealExhausted: { attested: false } });
  check("exhaustion · attested=false → 400", !r.ok && r.status === 400 && r.error === "external_review_requires_exhaustion");
}
{
  const r = checkEscalateGate({ targetLetterType: "external_review", isPro: true, appealExhausted: { attested: true } });
  check("exhaustion · attested=true + Pro → ok", r.ok === true && (r as { targetLetterType?: string }).targetLetterType === "external_review");
}

// ── ordering: Pro checked before exhaustion (a free user never leaks the gate) ─
{
  const r = checkEscalateGate({ targetLetterType: "external_review", isPro: false, appealExhausted: null });
  // S299: with the tier wall removed, a free unattested external_review now
  // fails on EXHAUSTION (400) — proving the exhaustion gate survives the
  // wall's removal (it must: ACA §2719 is law, not monetization).
  check("ordering · free + unattested → 400 (exhaustion holds, wall removed)", !r.ok && r.status === 400 && r.error === "external_review_requires_exhaustion");
}

// ── letter-access module (single source of truth shared with generate) ───────
// S299 (Andrew): PRO_LETTER_TYPES emptied — every rung is free; requiresPro
// false across the board. Machinery proven intact by the Pro→allowed check.
{
  const a = evaluateLetterAccess({ letterType: "final_notice", isPro: false });
  check(
    "access · final_notice free → allowed (wall removed S299)",
    a.allowed && a.requiresPro === false,
  );
}
check("access · external_review free → allowed (wall removed S299)", evaluateLetterAccess({ letterType: "external_review", isPro: false }).allowed);
check("access · final_notice Pro → allowed", evaluateLetterAccess({ letterType: "final_notice", isPro: true }).allowed);
check("access · debt_validation free → allowed", evaluateLetterAccess({ letterType: "debt_validation", isPro: false }).allowed);
check("access · letterRequiresPro(final_notice) === false (wall removed S299)", !letterRequiresPro("final_notice"));
check("access · letterRequiresPro(debt_validation) === false", !letterRequiresPro("debt_validation"));
check("access · letterRequiresPro(undefined) === false", !letterRequiresPro(undefined));

console.log(`\nescalate-gating fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
