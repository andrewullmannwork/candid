/**
 * stripe-error-classify — unit fixture for isStripeResourceMissing().
 *
 * Locks the guard that decides whether a Stripe failure self-heals (downgrade
 * to Free) vs surfaces as a retryable error. ONLY a definitive `resource_missing`
 * (404) may self-heal — a transient error (rate limit / api_error / network)
 * must NOT, or a Stripe blip would wrongly drop a paying user to Free.
 *
 * Run:  npx tsx scripts/calibration/fixtures/billing/stripe-error-classify.ts
 */
import { isStripeResourceMissing } from "../../../../src/lib/stripe/subscription-sync";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) pass++;
  else fails.push(`✗ ${name}`);
}

// ── self-heals: definitive resource_missing (404) ────────────────────────────
check("resource_missing → true", isStripeResourceMissing({ code: "resource_missing" }));
check(
  "StripeInvalidRequestError-shaped resource_missing → true",
  isStripeResourceMissing({ type: "StripeInvalidRequestError", code: "resource_missing", statusCode: 404 }),
);

// ── does NOT self-heal: transient / non-missing errors ───────────────────────
check("rate_limit → false", !isStripeResourceMissing({ code: "rate_limit" }));
check("api_error → false", !isStripeResourceMissing({ code: "api_error" }));
check("card_declined → false", !isStripeResourceMissing({ code: "card_declined" }));
check("no code field → false", !isStripeResourceMissing({ message: "boom" }));
check("generic Error → false", !isStripeResourceMissing(new Error("network down")));
check("null → false", !isStripeResourceMissing(null));
check("undefined → false", !isStripeResourceMissing(undefined));
check("bare string → false", !isStripeResourceMissing("resource_missing"));

console.log(`\nstripe-error-classify fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
