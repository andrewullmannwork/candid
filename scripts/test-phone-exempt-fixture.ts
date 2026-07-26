#!/usr/bin/env tsx
/**
 * Test-phone exemption fixture (S288; manually re-runnable).
 *
 * Covers the pure allowlist matcher ONLY (src/lib/auth/test-phone-exempt.ts):
 *   - every common US formatting of the ONE exempt number matches
 *   - near-misses (off-by-one digit, truncation, extra digits, other numbers,
 *     garbage, empty/null/undefined) never match
 *   - the E.164 constant and the matcher agree with each other
 *
 * NOT tested here (needs Firebase + Turnstile + DB — proven in the authed
 * E2E): the /api/auth/sync gate-bypass/stamp wiring and the KV kill switch
 * (server-read via getFlags; toggled in /admin/settings).
 *
 * Run: npx tsx scripts/test-phone-exempt-fixture.ts
 */

import {
  isTestPhoneExempt,
  TEST_PHONE_EXEMPT_E164,
  TEST_PHONE_EXEMPTION_FLAG,
} from "../src/lib/auth/test-phone-exempt";

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(
      `  ✗ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

console.log("test-phone-exempt fixture");

// Constant sanity — matcher and constants must agree.
check("constant is the E.164 test number", TEST_PHONE_EXEMPT_E164, "+19042941389");
check("flag key is the KV key", TEST_PHONE_EXEMPTION_FLAG, "TEST_PHONE_EXEMPTION_ENABLED");
check("constant matches itself", isTestPhoneExempt(TEST_PHONE_EXEMPT_E164), true);

// Every common formatting of the exempt number — all match.
for (const v of [
  "904-294-1389",
  "(904) 294-1389",
  "904.294.1389",
  "904 294 1389",
  "9042941389",
  "19042941389",
  "+1 904-294-1389",
  "+1 (904) 294 1389",
  " +19042941389 ",
]) {
  check(`matches ${JSON.stringify(v)}`, isTestPhoneExempt(v), true);
}

// Everything else — never matches.
for (const v of [
  "904-294-1388", // off by one digit
  "904-294-138", // truncated
  "90429413899", // 11 digits, not leading-1
  "290429413890", // 12 digits with the number embedded
  "+29042941389", // 11 digits, non-US lead
  "804-294-1389", // different area code
  "1-904-294-138", // 10 digits, leading 1, wrong tail
  "",
  "not a phone",
]) {
  check(`rejects ${JSON.stringify(v)}`, isTestPhoneExempt(v), false);
}
check("rejects null", isTestPhoneExempt(null), false);
check("rejects undefined", isTestPhoneExempt(undefined), false);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
