/**
 * Subscription tier predicate fixture — Block B (Dispute Letter Overhaul).
 *
 * Block Ship Gate G4 — manually-runnable fixture (no CI wiring yet; follow-up
 * obligation per Gate 4 spec). Exercises the pure server/client-shared predicate
 * in src/lib/subscription/tier.ts that backs every dispute-artifact tier gate
 * (generate / case-file / redraft / evidence-package).
 *
 * The load-bearing case is `pro` + `past_due` → NOT paid: a delinquent row keeps
 * tier "pro" (the invoice.payment_failed webhook flips status, not tier), and the
 * legacy tier-only `canAccessFeature` would wrongly grant access. isPaidTier must
 * match the client `isPro` exactly so server and client never disagree.
 *
 * Run:
 *   cd /Users/andrewullmann/Desktop/candid
 *   npx tsx scripts/calibration/fixtures/subscription-tier.ts
 *
 * Pass criteria: all cases assert PASS. Exit code 0 on PASS, 1 on any failure.
 */

import { isPaidTier } from "../../../src/lib/subscription/tier";
import type {
  SubscriptionTier,
  SubscriptionStatus,
} from "../../../src/lib/subscription/tier";

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
function eq<T>(label: string, got: T, want: T): void {
  if (got === want) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// ---------------------------------------------------------------------------
// Full (tier × status) matrix — want === true only for pro × {active,trialing}.
// ---------------------------------------------------------------------------
const TIERS: SubscriptionTier[] = ["free", "pro"];
const STATUSES: SubscriptionStatus[] = [
  "none",
  "trialing",
  "active",
  "canceled",
  "past_due",
];

for (const tier of TIERS) {
  for (const status of STATUSES) {
    const want = tier === "pro" && (status === "active" || status === "trialing");
    eq(`isPaidTier(${tier}, ${status})`, isPaidTier(tier, status), want);
  }
}

// ---------------------------------------------------------------------------
// The precision cases that motivated the predicate (vs tier-only checks).
// ---------------------------------------------------------------------------
eq("pro + active → paid", isPaidTier("pro", "active"), true);
eq("pro + trialing → paid", isPaidTier("pro", "trialing"), true);
eq("pro + past_due → NOT paid (delinquent; the canAccessFeature hole)", isPaidTier("pro", "past_due"), false);
eq("pro + canceled → NOT paid", isPaidTier("pro", "canceled"), false);
eq("pro + none → NOT paid", isPaidTier("pro", "none"), false);
eq("free + active → NOT paid", isPaidTier("free", "active"), false);

// ---------------------------------------------------------------------------
// Null / undefined inputs (missing stripe_customers row, malformed data) →
// fail-safe to NOT paid. loadServerSubscription defaults these to free/none,
// but the predicate itself must also be safe.
// ---------------------------------------------------------------------------
eq("null tier → NOT paid", isPaidTier(null, "active"), false);
eq("undefined tier → NOT paid", isPaidTier(undefined, "active"), false);
eq("pro + null status → NOT paid", isPaidTier("pro", null), false);
eq("pro + undefined status → NOT paid", isPaidTier("pro", undefined), false);
eq("undefined + undefined → NOT paid", isPaidTier(undefined, undefined), false);

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`Subscription tier fixture: ${pass} passed, ${fail} failed`);
console.log("=".repeat(60));
process.exit(fail > 0 ? 1 : 0);
