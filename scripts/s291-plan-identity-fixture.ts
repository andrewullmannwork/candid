/* S291 fixture — plan-identity resolver (Andrew E2E finding #4).
 * Runnable: npx tsx scripts/s291-plan-identity-fixture.ts
 *
 * The four load-bearing cases are REAL uploads from Andrew's DEV account on
 * 2026-07-28 (user 55f4bcec), not invented data. The old name-string check got
 * two of them wrong, one in each direction:
 *
 *   A  card ↔ first Cigna SBC, both canonical 353bdd94   → must NOT prompt
 *      (old code prompted — false positive)
 *   B  OAP Buy Up 1a201a32 vs Partnered Care 353bdd94    → MUST prompt
 *      (old code merged silently — false negative, the expensive one)
 *   C  UnitedHealthcare vs Cigna                          → MUST prompt
 *   D  'UHC' vs 'UnitedHealthcare Insurance Company'      → must NOT prompt
 *      (same carrier by catalog id; substring luck in the old normalize())
 *
 * Plus the confidence-floor guard: a canonical link BELOW 0.85 may not decide
 * identity on its own (Andrew's floor, S291).
 *
 * CI-wiring is a follow-up obligation (Ship Gate G4); manually runnable today.
 */
import {
  resolvePlanIdentity,
  normalizePlanText,
  CANONICAL_IDENTITY_CONFIDENCE_FLOOR,
  type PlanIdentityFacts,
} from "@/lib/plan/plan-identity";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const CIGNA = "insurer-cigna";
const UHC = "insurer-uhc";
const CANON_PARTNERED = "353bdd94-e758-422b-9249-b0cee3c7ff8a";
const CANON_OAP = "1a201a32-1a8b-40e8-a1d6-30c9117b9ecc";

const f = (o: PlanIdentityFacts): PlanIdentityFacts => o;

// ── A — same catalog plan, different name strings → SAME (no prompt) ────────
const a = resolvePlanIdentity(
  f({ canonicalPlanId: CANON_PARTNERED, canonicalConfidence: 0.95, insurerCatalogId: CIGNA, insurerName: "Cigna", planName: "Midlands Choice Plus" }),
  f({ canonicalPlanId: CANON_PARTNERED, canonicalConfidence: 0.95, insurerCatalogId: CIGNA, insurerName: "Cigna", planName: "Cigna HealthCare of Florida, Inc.: Partnered Care Premier Gold" }),
);
check("A card ↔ SBC, same canonical → same (the old false positive)", a.verdict === "same", `${a.verdict}/${a.reason}`);

// ── B — same carrier, DIFFERENT catalog plan → DIFFERENT (must prompt) ──────
const b = resolvePlanIdentity(
  f({ canonicalPlanId: CANON_PARTNERED, canonicalConfidence: 0.95, insurerCatalogId: CIGNA, insurerName: "Cigna", planName: "Cigna HealthCare of Florida, Inc.: Partnered Care Premier Gold" }),
  f({ canonicalPlanId: CANON_OAP, canonicalConfidence: 0.95, insurerCatalogId: CIGNA, insurerName: "Cigna", planName: "OAP Buy Up" }),
);
check("B OAP Buy Up vs Partnered Care → different (the old FALSE NEGATIVE)", b.verdict === "different", `${b.verdict}/${b.reason}`);
check("B names the reason for the user", b.evidence.includes("different plan ID"), b.evidence);

// ── B2 — the same case with the profile's plan_name EMPTY, which is exactly
// how it slipped through: the old check read profiles.plan_name and bailed.
const b2 = resolvePlanIdentity(
  f({ canonicalPlanId: CANON_PARTNERED, canonicalConfidence: 0.95, insurerCatalogId: CIGNA, insurerName: "Cigna", planName: null }),
  f({ canonicalPlanId: CANON_OAP, canonicalConfidence: 0.95, insurerCatalogId: CIGNA, insurerName: "Cigna", planName: "OAP Buy Up" }),
);
check("B2 still different with NO plan_name on file (name-blind)", b2.verdict === "different", `${b2.verdict}/${b2.reason}`);

// ── C — different carrier → DIFFERENT ──────────────────────────────────────
const c = resolvePlanIdentity(
  f({ canonicalPlanId: CANON_PARTNERED, canonicalConfidence: 0.95, insurerCatalogId: CIGNA, insurerName: "Cigna", planName: "Partnered Care Premier Gold" }),
  f({ canonicalPlanId: "f6c46850-edb5-494c-84d7-aa7c6150478b", canonicalConfidence: 0.95, insurerCatalogId: UHC, insurerName: "UnitedHealthcare Insurance Company", planName: "UHC Gold Advantage" }),
);
check("C Cigna → UnitedHealthcare → different", c.verdict === "different" && c.reason === "insurer_differs", `${c.verdict}/${c.reason}`);

// ── D — abbreviation, SAME carrier by catalog id → not a carrier change ─────
const d = resolvePlanIdentity(
  f({ insurerCatalogId: UHC, insurerName: "UHC", planName: "Gold Advantage" }),
  f({ insurerCatalogId: UHC, insurerName: "UnitedHealthcare Insurance Company", planName: "Gold Advantage" }),
);
check("D 'UHC' vs 'UnitedHealthcare' → NOT different (catalog id wins)", d.verdict !== "different", `${d.verdict}/${d.reason}`);

// ── Confidence floor (Andrew: 0.85) ────────────────────────────────────────
const lowSame = resolvePlanIdentity(
  f({ canonicalPlanId: CANON_PARTNERED, canonicalConfidence: 0.6, insurerCatalogId: CIGNA, insurerName: "Cigna", planName: "Plan A" }),
  f({ canonicalPlanId: CANON_PARTNERED, canonicalConfidence: 0.6, insurerCatalogId: CIGNA, insurerName: "Cigna", planName: "Plan B" }),
);
check("floor: canonical BELOW 0.85 can't force 'same' — falls through to names", lowSame.verdict === "different", `${lowSame.verdict}/${lowSame.reason}`);

const lowDiff = resolvePlanIdentity(
  f({ canonicalPlanId: CANON_PARTNERED, canonicalConfidence: 0.6, insurerCatalogId: CIGNA, insurerName: "Cigna", planName: "Same Plan" }),
  f({ canonicalPlanId: CANON_OAP, canonicalConfidence: 0.6, insurerCatalogId: CIGNA, insurerName: "Cigna", planName: "Same Plan" }),
);
check("floor: canonical BELOW 0.85 can't force 'different' either", lowDiff.verdict !== "different", `${lowDiff.verdict}/${lowDiff.reason}`);

const unscored = resolvePlanIdentity(
  f({ canonicalPlanId: CANON_PARTNERED, insurerCatalogId: CIGNA, insurerName: "Cigna" }),
  f({ canonicalPlanId: CANON_OAP, insurerCatalogId: CIGNA, insurerName: "Cigna" }),
);
check("floor: UNSCORED canonical link is unknown, not certain → uncertain", unscored.verdict === "uncertain", `${unscored.verdict}/${unscored.reason}`);
check("floor constant is 0.85 (Andrew's pick)", CANONICAL_IDENTITY_CONFIDENCE_FLOOR === 0.85, String(CANONICAL_IDENTITY_CONFIDENCE_FLOOR));

// ── Stronger signals outrank names ─────────────────────────────────────────
const hios = resolvePlanIdentity(
  f({ hiosId: "79850FL0020003", insurerName: "Cigna", planName: "Old Marketing Name" }),
  f({ hiosId: "79850FL0020003", insurerName: "Cigna", planName: "Totally Different Marketing Name" }),
);
check("HIOS id outranks a name disagreement → same", hios.verdict === "same" && hios.reason === "hios_match", `${hios.verdict}/${hios.reason}`);

const group = resolvePlanIdentity(
  f({ groupNumber: "0012345", insurerCatalogId: CIGNA, insurerName: "Cigna", planName: "A" }),
  f({ groupNumber: "0012345", insurerCatalogId: CIGNA, insurerName: "Cigna", planName: "B" }),
);
check("group + insurer → same", group.verdict === "same" && group.reason === "group_and_insurer_match", `${group.verdict}/${group.reason}`);

const groupCollision = resolvePlanIdentity(
  f({ groupNumber: "0012345", insurerCatalogId: CIGNA, insurerName: "Cigna", planName: "A" }),
  f({ groupNumber: "0012345", insurerCatalogId: UHC, insurerName: "UnitedHealthcare", planName: "A" }),
);
check("same group at DIFFERENT insurers is not a match (collision guard)", groupCollision.verdict === "different", `${groupCollision.verdict}/${groupCollision.reason}`);

// ── Preserve-on-uncertainty ────────────────────────────────────────────────
const nothing = resolvePlanIdentity(f({ insurerName: "Cigna" }), f({ insurerName: "Cigna" }));
check("no usable signal → uncertain (ask, never guess)", nothing.verdict === "uncertain", `${nothing.verdict}/${nothing.reason}`);

const carrierPrefix = resolvePlanIdentity(
  f({ insurerName: "Cigna", planName: "Open Access Plus" }),
  f({ insurerName: "Cigna HealthCare of Florida, Inc.", planName: "Open Access Plus" }),
);
check("carrier-name containment is not a carrier change", carrierPrefix.verdict !== "different", `${carrierPrefix.verdict}/${carrierPrefix.reason}`);

check("normalize strips corporate suffixes", normalizePlanText("Cigna HealthCare of Florida, Inc.") === "cigna", `"${normalizePlanText("Cigna HealthCare of Florida, Inc.")}"`);

const total = 16;
console.log(`\n${total} assertions — ${total - failures} passed, ${failures} failed`);
if (failures > 0) {
  console.error("✗ s291-plan-identity fixture RED");
  process.exit(1);
}
console.log("✓ s291-plan-identity fixture green");
