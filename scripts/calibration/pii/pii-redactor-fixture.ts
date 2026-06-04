/**
 * Ing-E Phase 2 — redactor fixture (Ship Gate G4).
 *
 * The core invariant (Q1): redaction NEVER removes coverage text. Plus: byte-identical
 * when there's nothing to redact, review-tier/guard spans untouched, overlapping auto
 * spans merge (no nested markers), and idempotency.
 *
 * Run: npx tsx scripts/calibration/pii/pii-redactor-fixture.ts
 */
import { redactText, redact } from "@/lib/parser/pii-redactor";
import { redactExcerpt } from "@/lib/parser/pii-redaction-gate";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean): void {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
  }
}
const markerCount = (s: string): number => (s.match(/\[REDACTED:/g) ?? []).length;

// ─── byte-identical when nothing to redact ───
check("null → empty, unchanged", redactText(null).redacted === "" && redactText(null).changed === false);
const cov = "Primary care visit: $30 copay";
check("pure coverage → byte-identical (no auto)", redact(cov) === cov && redactText(cov).changed === false);
check("coinsurance line → byte-identical", redact("Inpatient: 20% coinsurance after deductible") === "Inpatient: 20% coinsurance after deductible");

// ─── review-tier NOT redacted (Q4: names stay) ───
const nameCase = "Patient: John Smith";
check("name (review) NOT redacted — byte-identical", redact(nameCase) === nameCase && redactText(nameCase).changed === false);
check("name surfaced in reviewFlagged", redactText(nameCase).reviewFlagged.some((m) => m.patternName === "name_labeled"));
check("bare phone (review) NOT redacted", redact("call 555-123-4567") === "call 555-123-4567");

// ─── auto-tier IS redacted; original value gone ───
const mid = "Member ID: W123456789";
const midOut = redactText(mid);
check("member id redacted (changed)", midOut.changed === true);
check("member id value removed from output", !midOut.redacted.includes("W123456789"));
check("member id output carries a marker", midOut.redacted.includes("[REDACTED:"));
check("ssn redacted", redact("SSN 123-45-6789").includes("[REDACTED:ssn]") && !redact("SSN 123-45-6789").includes("123-45-6789"));
check("dob + email redacted together", (() => { const r = redact("DOB: 01/15/1980 email a@b.com"); return !r.includes("01/15/1980") && !r.includes("a@b.com"); })());

// ─── THE Q1 INVARIANT: coverage text survives redaction byte-for-byte ───
const mixed = "Member ID: W123456789 — Primary care visit $30 copay";
const mixedOut = redact(mixed);
check("Q1: '$30 copay' preserved through redaction", mixedOut.includes("$30 copay"));
check("Q1: 'Primary care visit' preserved", mixedOut.includes("Primary care visit"));
check("Q1: PII value gone", !mixedOut.includes("W123456789"));
const mixed2 = "Subscriber: 555-12-3456 — Specialist 30% coinsurance, $50 copay";
const mixed2Out = redact(mixed2);
check("Q1: '%' coverage preserved", mixed2Out.includes("30% coinsurance"));
check("Q1: '$50 copay' preserved", mixed2Out.includes("$50 copay"));
check("Q1: ssn gone", !mixed2Out.includes("555-12-3456"));

// ─── overlap merge: 'Member ID: Wxxxxxxxxx' (member_id_labeled ⊇ insurer_aetna_w_id) → ONE marker ───
check("overlapping auto spans merge to one marker", markerCount(mixedOut) === 1);
check("no nested markers anywhere", !mixedOut.includes("[REDACTED:[REDACTED"));

// ─── idempotency: redacting already-redacted text is a no-op ───
check("idempotent (redact∘redact === redact)", redact(mixedOut) === mixedOut);
check("idempotent on member id", redact(midOut.redacted) === midOut.redacted);

// ─── coverage-guarded match is NOT redacted (e.g. $-prefixed NPI-shaped number) ───
check("guarded $-amount not redacted", redact("balance $1234567893 due") === "balance $1234567893 due");

// ─── gate: enabled=false is byte-identical even WITH PII (the flag-OFF guarantee) ───
const withPii: string = "Member ID: W123456789 — $30 copay";
check("gate OFF → byte-identical even with PII present", redactExcerpt(withPii, false, "t") === withPii);
check("gate ON → redacts PII, preserves coverage", (() => {
  const r = redactExcerpt(withPii, true, "t");
  return r !== withPii && !r.includes("W123456789") && r.includes("$30 copay");
})());
check("gate → null passthrough", redactExcerpt(null, true, "t") === null);

const total = pass + fail;
console.log(`\nPII redactor fixture: ${pass}/${total} PASS`);
if (fail > 0) {
  console.log(`\n${fail} FAILURE(S):`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all assertions passed (incl. Q1 coverage-preservation invariant)\n");
