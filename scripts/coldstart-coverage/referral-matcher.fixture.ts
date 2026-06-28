/**
 * Fixture: explicitReferralSignal truth-table (Fix A — coverage_dims referral matcher).
 * Negation-first + modality-aware. Pure unit test (no model call).
 *   npx tsx scripts/coldstart-coverage/referral-matcher.fixture.ts
 */
import { explicitReferralSignal } from "@/lib/plan_doc/haiku-prompts/services-cost-sharing";

const CASES: Array<[string, boolean | null]> = [
  // definite positive
  ["referral required", true],
  ["a referral is required for this service", true],
  ["requires a referral", true],
  ["pcp referral needed", true],
  ["referral needed", true],
  ["referral is mandatory", true],
  // conditional modal positive (the corpus bug Fix A targets)
  ["referral may be required", true],
  ["referral might be required", true],
  ["referral could be needed", true],
  ["referral may be required. preauthorization may also be required", true],
  ["referral is necessary", true],
  // negation (must beat the modal — the trap)
  ["no referral required", false],
  ["no referral needed", false],
  ["referral not required", false],
  ["referral is not required", false],
  ["referral may not be required", false],
  ["self-referral", false],
  ["self referral allowed", false],
  ["direct access", false],
  ["you do not need a referral", false],
  ["does not require a referral", false],
  ["referral requirement is waived", false],
  // silent → null
  ["$30 copay per visit", null],
  ["20% coinsurance after deductible", null],
  ["covered in full", null],
  ["", null],
];

let pass = 0;
const fails: string[] = [];
for (const [text, want] of CASES) {
  const got = explicitReferralSignal(text);
  if (got === want) pass++;
  else fails.push(`  FAIL: "${text}" → got ${got}, want ${want}`);
}
if (fails.length) console.log(fails.join("\n"));
console.log(`\nreferral matcher: ${pass}/${CASES.length} pass${fails.length ? ` · ${fails.length} FAIL` : ""}`);
process.exit(fails.length ? 1 : 0);
