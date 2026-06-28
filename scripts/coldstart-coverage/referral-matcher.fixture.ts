/**
 * Fixture: explicitReferralSignal truth-table (Fix A — coverage_dims referral matcher) + the
 * verifyReferralGrounding anchor-proximity gate (Fix A grounding, S250). Pure unit tests (no model call).
 *   npx tsx scripts/coldstart-coverage/referral-matcher.fixture.ts
 */
import { explicitReferralSignal, verifyReferralGrounding } from "@/lib/plan_doc/haiku-prompts/services-cost-sharing";

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
  else fails.push(`  matcher FAIL: "${text}" → got ${got}, want ${want}`);
}

// Fix A grounding (S250): a per-service signal is trusted only when a referral/direct-access token sits
// within ~400 chars of the service's anchor in the section — else it's an LLM copy from elsewhere.
const PAD = "padding ".repeat(80); // ~640 chars, contains no referral wording
const SECTION =
  "Specialist visit\n50% coinsurance\nReferral required. Preauthorization may also be required.\n" +
  PAD +
  "\nPreventive care\nNo charge; deductible does not apply\nNo special conditions noted here.";
const GROUNDING: Array<[string, string, boolean]> = [
  ["50% coinsurance", SECTION, true], // anchor sits next to the referral note → grounded
  ["No charge; deductible does not apply", SECTION, false], // anchor is >400 chars from any referral token → ungrounded
  ["50% coinsurance", "Specialist visit\n50% coinsurance\nNo conditions noted.", false], // no referral token anywhere
  ["anchor text not present in this section", SECTION, true], // anchor unlocatable → lenient (never drop a real signal)
  ["No charge", "Preventive care\nNo charge\nDirect access; no referral needed.", true], // direct-access is a grounded signal
];
for (const [anchor, section, want] of GROUNDING) {
  const got = verifyReferralGrounding(anchor, section);
  if (got === want) pass++;
  else fails.push(`  grounding FAIL: anchor="${anchor}" → got ${got}, want ${want}`);
}

const totalCases = CASES.length + GROUNDING.length;
if (fails.length) console.log(fails.join("\n"));
console.log(`\nreferral matcher + grounding: ${pass}/${totalCases} pass${fails.length ? ` · ${fails.length} FAIL` : ""}`);
process.exit(fails.length ? 1 : 0);
