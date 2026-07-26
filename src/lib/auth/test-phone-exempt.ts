/**
 * Test-phone exemption (S288) — allows EXACTLY ONE hardcoded number (Andrew's
 * test number) to exist on multiple Candid accounts simultaneously, for
 * multi-account E2E testing (fresh signups; exercising the ≥3-verified-user
 * corroboration flywheel).
 *
 * Mechanism: the one-account-per-phone rule is enforced by Firebase itself at
 * linkWithPhoneNumber (auth/credential-already-in-use) — NOT by our schema
 * (users.phone_e164 has no unique index). When the exemption is active, signup
 * SKIPS the Firebase phone-link entirely for this number and /api/auth/sync
 * stamps users.phone_e164 + phone_verified directly (declared, not OTP-proven —
 * acceptable ONLY because the number is allowlisted here in code and belongs
 * to the operator).
 *
 * Kill switch: feature_flags KV row TEST_PHONE_EXEMPTION_ENABLED (mig 209;
 * /admin/settings → Testing; instant, no deploy). OFF → this number behaves
 * like any other (real OTP, one account per phone), and already-stamped
 * accounts downgrade to phone_verified=false on their next sync.
 *
 * Adding or changing numbers requires a code change here — by design.
 */

export const TEST_PHONE_EXEMPT_E164 = "+19042941389";

/** feature_flags KV key (NOT a feature_flag_rules row) backing the kill switch. */
export const TEST_PHONE_EXEMPTION_FLAG = "TEST_PHONE_EXEMPTION_ENABLED";

const EXEMPT_10_DIGIT = TEST_PHONE_EXEMPT_E164.slice(2); // "9042941389"

/**
 * True iff `raw` is the exempt test number in any common US formatting:
 * "904-294-1389", "(904) 294-1389", "+1 904 294 1389", "19042941389",
 * "9042941389". Anything that doesn't normalize to exactly the allowlisted
 * 10-digit US number is false.
 */
export function isTestPhoneExempt(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits === EXEMPT_10_DIGIT;
}
