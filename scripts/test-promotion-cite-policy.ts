/**
 * N1 layer-4 — the promotion-provenance contract test (mig 187 §14).
 *
 * The compile-time guarantee (a REQUIRED CitePolicy on applyPromotionEvent) is enforced by tsc + the
 * no-direct-promotion-rpc ESLint guard. This test guards the runtime observability signal (citationGap)
 * and the CITE_GRADE_FIELDS set against drift, and smoke-checks both CitePolicy variants construct.
 *
 *   npx tsx scripts/test-promotion-cite-policy.ts
 */
import { citationGap, CITE_GRADE_FIELDS, type CitePolicy } from "../src/lib/parser/promotion-event";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

// 1) a non-cite-grade field is never flagged, regardless of policy
assert(
  citationGap("plan_name", { cite: false, reason: "plan_identity" }) === null,
  "plan_name (not cite-grade) → null",
);

// 2) a cite-grade field promoted cite:false → flagged, and the reason is surfaced
const g1 = citationGap("in_copay", { cite: false, reason: "no_excerpt" });
assert(g1 !== null && g1.includes("no_excerpt"), "in_copay cite:false → flagged with reason");

// 3) a cite-grade field cite:true with a real excerpt → not flagged
assert(
  citationGap("in_coinsurance", { cite: true, meta: { sourceExcerpt: "20% coinsurance after deductible" } }) === null,
  "in_coinsurance cite:true w/ excerpt → null",
);

// 4) a cite-grade field cite:true but with an EMPTY/whitespace excerpt → flagged
const g2 = citationGap("requires_referral", { cite: true, meta: { sourceExcerpt: "   " } });
assert(g2 !== null && g2.includes("empty"), "requires_referral cite:true empty excerpt → flagged");

// 5) every canonical coverage column mig 187 writes is in the set (drift guard vs the migration)
for (const f of [
  "in_copay", "in_coinsurance", "in_deductible_applies", "covered", "prior_auth_required",
  "out_copay", "out_coinsurance", "out_deductible_applies", "requires_referral", "visit_limit", "annual_limit",
]) {
  assert(CITE_GRADE_FIELDS.has(f), `CITE_GRADE_FIELDS has ${f}`);
}

// 6) both CitePolicy variants construct (compile-time smoke — tsc fails the build if the union drifts)
const _variants: CitePolicy[] = [
  { cite: true, meta: { sourceExcerpt: "x", sourceExcerptVerified: true, resolutionSource: "synonym_remap" } },
  { cite: false, reason: "admin_attested" },
];
void _variants;

console.log(`[cite-policy] passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
