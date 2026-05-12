/**
 * S73.5 D2b — CF-40 v4 5-layer algorithm tests.
 *
 * Validates Layer 1-5 pure functions + orchestrator + badge derivation +
 * dispute treatment.
 *
 * Run: `npx tsx scripts/test-cf40-v4-algorithm.ts`
 */

import {
  getScaleTier,
  supermajorityThreshold,
  CORROBORATION_THRESHOLDS,
  REPARSE_SAMPLING,
  resolveTrustTier,
  effectiveWeight,
  getTimeDecayMultiplier,
  parseAgeDays,
  STABILITY_THRESHOLD,
  evaluateValidityGates,
  VALIDITY_THRESHOLDS,
  decideForcedReparse,
  evaluateOrganicPromotion,
  evaluateAdminAttestation,
  deriveBadgeLevel,
  deriveBackendConfidence,
  BADGE_LABEL,
  getDisputeLetterTreatment,
  evaluateSmartSkipEligibility,
  CF40_V4_FLAG_KEY,
  ADMIN_ATTESTATION_FLAG_KEY,
} from "@/lib/parser/cf40-v4";

let pass = 0;
let fail = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("\n=== S73.5 D2b: CF-40 v4 algorithm ===\n");

// ── Scale tier ──────────────────────────────────────────────────────────────
console.log("[1] getScaleTier()");
assert(getScaleTier(0) === "cold_start", "0 → cold_start");
assert(getScaleTier(100) === "cold_start", "100 → cold_start");
assert(getScaleTier(101) === "small", "101 → small");
assert(getScaleTier(10_000) === "small", "10K → small");
assert(getScaleTier(10_001) === "medium", "10K+1 → medium");
assert(getScaleTier(1_000_000) === "medium", "1M → medium");
assert(getScaleTier(1_000_001) === "large", "1M+1 → large");

// ── Supermajority threshold ─────────────────────────────────────────────────
console.log("\n[2] supermajorityThreshold()");
assert(supermajorityThreshold(5, "cold_start") === 1.0, "5 uploads → 1.0 (no divergence)");
assert(supermajorityThreshold(10, "cold_start") === 1.0, "10 uploads → 1.0");
assert(supermajorityThreshold(11, "cold_start") === 0.80, "11 uploads → 0.80");
assert(supermajorityThreshold(500, "small") === 0.66, "small scale → 0.66");
assert(supermajorityThreshold(50_000, "medium") === 0.66, "medium → 0.66");
assert(supermajorityThreshold(5_000_000, "large") === 0.66, "large → 0.66");

// ── Trust weight + time decay ───────────────────────────────────────────────
console.log("\n[3] Trust + time-decay");
assert(
  resolveTrustTier({ isAdmin: true, phoneVerified: false, emailVerified: false }) === "admin",
  "isAdmin → admin tier",
);
assert(
  resolveTrustTier({ isAdmin: false, phoneVerified: true, emailVerified: true }) ===
    "phone_email_verified",
  "phone + email → phone_email_verified",
);
assert(
  resolveTrustTier({ isAdmin: false, phoneVerified: true, emailVerified: false }) ===
    "phone_only_verified",
  "phone only → phone_only_verified",
);
assert(
  resolveTrustTier({ isAdmin: false, phoneVerified: false, emailVerified: true }) ===
    "email_only_verified",
  "email only → email_only_verified",
);
assert(
  resolveTrustTier({ isAdmin: false, phoneVerified: false, emailVerified: false }) ===
    "unverified",
  "neither → unverified",
);

assert(getTimeDecayMultiplier(0) === 1.0, "0 days → 1.0");
assert(getTimeDecayMultiplier(90) === 1.0, "90 days → 1.0 (boundary)");
assert(getTimeDecayMultiplier(91) === 0.5, "91 days → 0.5");
assert(getTimeDecayMultiplier(180) === 0.5, "180 days → 0.5");
assert(getTimeDecayMultiplier(181) === 0.2, "181 days → 0.2");
assert(getTimeDecayMultiplier(365) === 0.2, "365 days → 0.2");
assert(getTimeDecayMultiplier(366) === 0.0, "366 days → 0.0");

assert(effectiveWeight("admin", 0) === 3.0, "admin × recent → 3.0");
assert(effectiveWeight("phone_email_verified", 0) === 1.0, "phone+email × recent → 1.0");
assert(effectiveWeight("phone_email_verified", 100) === 0.5, "phone+email × 100d → 0.5");
assert(effectiveWeight("phone_only_verified", 0) === 0.6, "phone-only × recent → 0.6");
assert(effectiveWeight("email_only_verified", 0) === 0.5, "email-only × recent → 0.5");
assert(effectiveWeight("unverified", 0) === 0.0, "unverified × recent → 0.0");

assert(STABILITY_THRESHOLD === 3.0, "STABILITY_THRESHOLD === 3.0");

// ── parseAgeDays helper ─────────────────────────────────────────────────────
console.log("\n[4] parseAgeDays()");
const now = new Date("2026-05-11T00:00:00Z");
assert(parseAgeDays(new Date("2026-05-11T00:00:00Z"), now) === 0, "same day → 0");
assert(parseAgeDays(new Date("2026-05-01T00:00:00Z"), now) === 10, "10 days ago → 10");
assert(parseAgeDays(new Date("2025-05-11T00:00:00Z"), now) === 365, "1 year ago → 365");

// ── Layer 1 validity gates ──────────────────────────────────────────────────
console.log("\n[5] Layer 1 validity gates");
const baseValidity: Parameters<typeof evaluateValidityGates>[0] = {
  selfCheckPassRate: 1.0,
  ocrConfidence: 1.0,
  classificationConfidence: 1.0,
  uploadedAt: new Date("2026-05-11T00:00:00Z"),
  documentPlanYear: 2026,
  fileSizeBytes: 200_000,
  docType: "sbc",
  uploaderTier: "phone_email_verified",
  isAdmin: false,
  isBanned: false,
  canonicalReBaselineRequired: false,
};
assert(evaluateValidityGates(baseValidity).pass === true, "all green → pass");

assert(
  evaluateValidityGates({ ...baseValidity, selfCheckPassRate: 0.9 }).pass === false,
  "self-check 0.9 < 0.95 → fail",
);
assert(
  evaluateValidityGates({ ...baseValidity, ocrConfidence: 0.5 }).pass === false,
  "OCR 0.5 < 0.85 → fail",
);
assert(
  evaluateValidityGates({ ...baseValidity, classificationConfidence: 0.8 }).pass === false,
  "classification 0.8 < 0.90 → fail",
);
// 2024 SBC uploaded Sep 2026 — past validity window for 2024 plan year
assert(
  evaluateValidityGates({
    ...baseValidity,
    uploadedAt: new Date("2026-09-15T00:00:00Z"),
    documentPlanYear: 2024,
  }).pass === false,
  "stale 2024 SBC in Sep 2026 → fail (outside_validity_window)",
);
// SBC file size 10KB (below 20KB SBC threshold)
assert(
  evaluateValidityGates({ ...baseValidity, fileSizeBytes: 10_000 }).pass === false,
  "10KB SBC < 20KB minimum → fail",
);
// SBC 50KB pass
assert(
  evaluateValidityGates({ ...baseValidity, fileSizeBytes: 50_000 }).pass === true,
  "50KB SBC ≥ 20KB minimum → pass",
);
// plan_document with 30KB < 50KB minimum
assert(
  evaluateValidityGates({ ...baseValidity, docType: "plan_document", fileSizeBytes: 30_000 })
    .pass === false,
  "30KB plan_document < 50KB minimum → fail",
);
// Banned user
assert(
  evaluateValidityGates({ ...baseValidity, isBanned: true }).pass === false,
  "banned user → fail",
);
// Unverified non-admin
assert(
  evaluateValidityGates({ ...baseValidity, uploaderTier: "unverified", isAdmin: false }).pass ===
    false,
  "unverified + non-admin → fail (uploader_unauthenticated)",
);
// Unverified BUT admin
assert(
  evaluateValidityGates({ ...baseValidity, uploaderTier: "unverified", isAdmin: true }).pass ===
    true,
  "unverified BUT admin → pass (admin override)",
);
// re_baseline_required
assert(
  evaluateValidityGates({ ...baseValidity, canonicalReBaselineRequired: true }).pass === false,
  "canonical re-baseline required → fail",
);
// Unextractable plan_year → fall back to absolute age (within 12 months)
const fallbackResult = evaluateValidityGates({
  ...baseValidity,
  documentPlanYear: null,
});
assert(fallbackResult.pass === true, "missing plan_year → falls back to absolute age (within 12mo) → pass");
assert(fallbackResult.fellBackToAbsoluteAge === true, "fellBackToAbsoluteAge=true");

// ── Layer 3 organic promotion ───────────────────────────────────────────────
console.log("\n[6] Layer 3 organic promotion");
const passInput = {
  corroboration: {
    distinctPhoneEmailUsers: 5,
    totalQualifyingUploads: 10,
    distinctCalendarDays: 5,
    timeSpanDays: 14,
    highVolumeDistinctUsers: 5,
  },
  supermajority: { baselineWeight: 5.0, totalWeight: 5.0 }, // 100%
  coverage: {
    verifiedScalarCount: 12,
    verifiedServiceCount: 8,
    observedServiceCounts: [],
  },
  uploadCount: 200,
  scaleTier: "small" as const,
  docType: "sbc" as const,
};
const r1 = evaluateOrganicPromotion(passInput);
assert(r1.promoted === true, "all 3 criteria pass → promoted");
assert(r1.observed.coverageScore === 1.0, "coverage score === 1.0");
assert(r1.observed.majorityShare === 1.0, "majority share === 1.0");

// Distinct user count below threshold
const r2 = evaluateOrganicPromotion({
  ...passInput,
  corroboration: { ...passInput.corroboration, distinctPhoneEmailUsers: 2 },
});
assert(r2.promoted === false, "2 distinct users < 5 (small tier) → NOT promoted");
assert(
  r2.failureReasons.includes("corroboration_distinct_users_below_threshold"),
  "failure includes distinct_users_below_threshold",
);

// Supermajority below threshold (small tier needs 0.66)
const r3 = evaluateOrganicPromotion({
  ...passInput,
  supermajority: { baselineWeight: 3, totalWeight: 5 }, // 0.6 < 0.66
});
assert(r3.promoted === false, "supermajority 0.6 < 0.66 → NOT promoted");

// Coverage below threshold (SBC needs 0.80)
const r4 = evaluateOrganicPromotion({
  ...passInput,
  coverage: { verifiedScalarCount: 4, verifiedServiceCount: 4, observedServiceCounts: [] },
});
// 4/12 + 4/8 = 0.1667 + 0.25 = 0.4167 < 0.80 → fail
assert(r4.promoted === false, "coverage 0.42 < 0.80 → NOT promoted");

// Cold-start with high-volume bypass (no temporal req)
const r5 = evaluateOrganicPromotion({
  corroboration: {
    distinctPhoneEmailUsers: 30,
    totalQualifyingUploads: 30,
    distinctCalendarDays: 1, // fails standard temporal
    timeSpanDays: 1, // fails standard temporal
    highVolumeDistinctUsers: 30, // ≥ 25 → bypass kicks in
  },
  supermajority: { baselineWeight: 30, totalWeight: 30 },
  coverage: passInput.coverage,
  uploadCount: 50,
  scaleTier: "cold_start" as const,
  docType: "sbc" as const,
});
assert(r5.promoted === true, "cold-start high-volume bypass → promoted despite temporal fail");

// ── Layer 3 admin attestation path ──────────────────────────────────────────
console.log("\n[7] Layer 3 admin attestation");
const adminInput = {
  coverage: passInput.coverage,
  adminUploadCountPerDocType: 2,
  docType: "sbc" as const,
};
assert(
  evaluateAdminAttestation(adminInput).promoted === true,
  "admin path: 2 admin uploads + coverage 1.0 → promoted",
);
assert(
  evaluateAdminAttestation({ ...adminInput, adminUploadCountPerDocType: 1 }).promoted === false,
  "admin path: 1 admin upload < 2 → NOT promoted (Q-S73.5-21 LOCK)",
);
assert(
  evaluateAdminAttestation({
    ...adminInput,
    coverage: {
      verifiedScalarCount: 4,
      verifiedServiceCount: 4,
      observedServiceCounts: [],
    },
  }).promoted === false,
  "admin path: coverage 0.42 < 0.80 → NOT promoted (3c still required)",
);

// ── Layer 5 forced re-parse ──────────────────────────────────────────────────
console.log("\n[8] Layer 5 forced re-parse");
const baseForce: Parameters<typeof decideForcedReparse>[0] = {
  isAdmin: false,
  scaleTier: "small",
  smartSkipCount: 0,
  lastFullParseAt: null,
  divergencePendingVerification: false,
  adminAttestedNeedsValidation: false,
  randomFn: () => 0.99, // always above sample rate
};

assert(
  decideForcedReparse({ ...baseForce, isAdmin: true }).forceFullParse === true,
  "admin upload → forced",
);
assert(
  decideForcedReparse({ ...baseForce, isAdmin: true }).reason === "admin_upload",
  "admin reason",
);

assert(
  decideForcedReparse({ ...baseForce, divergencePendingVerification: true }).forceFullParse === true,
  "verification mode → forced",
);

assert(
  decideForcedReparse({ ...baseForce, adminAttestedNeedsValidation: true }).forceFullParse === true,
  "admin attested needs validation → forced",
);

assert(
  decideForcedReparse({ ...baseForce, smartSkipCount: 5 }).forceFullParse === true,
  "smart_skip_count 5 (%5==0) → forced",
);
assert(
  decideForcedReparse({ ...baseForce, smartSkipCount: 5 }).reason === "every_5th_smart_skip",
  "smart_skip every-5th reason",
);
assert(
  decideForcedReparse({ ...baseForce, smartSkipCount: 4 }).forceFullParse === false,
  "smart_skip_count 4 (%5!=0) → NOT forced (rng 0.99 above 0.05)",
);

// Temporal staleness
const oldDate = new Date("2025-01-01T00:00:00Z");
const newDate = new Date("2026-05-11T00:00:00Z"); // ~495 days later, way past 90d
assert(
  decideForcedReparse({
    ...baseForce,
    lastFullParseAt: oldDate,
    now: newDate,
  }).forceFullParse === true,
  "lastFullParseAt 1y+ ago → forced (temporal_staleness)",
);

// Sample rate hits
assert(
  decideForcedReparse({ ...baseForce, randomFn: () => 0.01 }).forceFullParse === true,
  "rng 0.01 < 0.05 sample rate → forced (statistical_drift_sample)",
);

// All gates pass → not forced
assert(
  decideForcedReparse(baseForce).forceFullParse === false,
  "all gates pass → NOT forced",
);

// ── Badge derivation ────────────────────────────────────────────────────────
console.log("\n[9] Badge derivation");
assert(
  deriveBadgeLevel({
    canonicalFullyVerified: true,
    anyDocTypePromoted: true,
    userUploaded: true,
    userDocLayer2Stable: true,
    v4Fallback: "community",
  }) === "verified",
  "fully verified → Verified",
);
assert(
  deriveBadgeLevel({
    canonicalFullyVerified: false,
    anyDocTypePromoted: true,
    userUploaded: false,
    userDocLayer2Stable: false,
    v4Fallback: "community",
  }) === "community_and_document_verified",
  "any doc-type promoted (no upload) → Community & Document Verified",
);
assert(
  deriveBadgeLevel({
    canonicalFullyVerified: false,
    anyDocTypePromoted: false,
    userUploaded: true,
    userDocLayer2Stable: true,
    v4Fallback: "community",
  }) === "community_verified",
  "user uploaded + stable, no doctype promotion → Community Verified",
);
assert(
  deriveBadgeLevel({
    canonicalFullyVerified: false,
    anyDocTypePromoted: false,
    userUploaded: true,
    userDocLayer2Stable: false,
    v4Fallback: "community",
  }) === "user_verified",
  "user uploaded, no stability/promotion → User Verified",
);
assert(
  deriveBadgeLevel({
    canonicalFullyVerified: false,
    anyDocTypePromoted: false,
    userUploaded: false,
    userDocLayer2Stable: false,
    v4Fallback: "public_data",
  }) === "public_data",
  "no upload → falls back to v4 logic (public_data)",
);

// Labels
assert(BADGE_LABEL.verified === "Verified", "label: Verified");
assert(
  BADGE_LABEL.community_and_document_verified === "Community & Document Verified",
  "label: Community & Document Verified",
);

// ── Backend confidence ──────────────────────────────────────────────────────
console.log("\n[10] Backend confidence");
assert(
  deriveBackendConfidence({
    doctypePromotedForFieldSource: true,
    layer2Stable: true,
    userCiteGrade: true,
    userNoCite: false,
    inherited: false,
    publicOnly: false,
  }) === "verified",
  "doctype promoted → verified (regardless of visible badge tier per Rule B)",
);
assert(
  deriveBackendConfidence({
    doctypePromotedForFieldSource: false,
    layer2Stable: true,
    userCiteGrade: false,
    userNoCite: false,
    inherited: false,
    publicOnly: false,
  }) === "provisional",
  "layer2 stable but not promoted → provisional",
);
assert(
  deriveBackendConfidence({
    doctypePromotedForFieldSource: false,
    layer2Stable: false,
    userCiteGrade: true,
    userNoCite: false,
    inherited: false,
    publicOnly: false,
  }) === "user_cite_grade",
  "cite-grade only → user_cite_grade",
);
assert(
  deriveBackendConfidence({
    doctypePromotedForFieldSource: false,
    layer2Stable: false,
    userCiteGrade: false,
    userNoCite: false,
    inherited: false,
    publicOnly: true,
  }) === "public_only",
  "public dataset → public_only",
);

// ── Dispute letter treatment ────────────────────────────────────────────────
async function runDisputeTests() {
  console.log("\n[11] Dispute letter treatment");
  const verifiedResult = await getDisputeLetterTreatment({ backendConfidence: "verified" });
  assert(verifiedResult.mode === "blockquote", "verified → blockquote");
  assert(verifiedResult.disclaimer === null, "verified → no disclaimer");

  const ucgResult = await getDisputeLetterTreatment({ backendConfidence: "user_cite_grade" });
  assert(ucgResult.mode === "blockquote", "user_cite_grade → blockquote");
  assert(ucgResult.disclaimer === null, "user_cite_grade → no disclaimer");

  const hideResult = await getDisputeLetterTreatment({ backendConfidence: "user_no_cite" });
  assert(hideResult.mode === "hide", "user_no_cite → hide");

  const inhResult = await getDisputeLetterTreatment({ backendConfidence: "inherited" });
  assert(inhResult.mode === "hide", "inherited → hide");

  const pubResult = await getDisputeLetterTreatment({ backendConfidence: "public_only" });
  assert(pubResult.mode === "hide", "public_only → hide");

  const provHighCorr = await getDisputeLetterTreatment({
    backendConfidence: "provisional",
    canonicalPlanId: "c1",
    fieldName: "in_deductible_individual",
    serviceSlug: null,
    value: 1500,
    lookupCorroboration: async () => ({ distinctDocuments: 3, distinctUsers: 4 }),
  });
  assert(provHighCorr.mode === "blockquote", "provisional + (≥2 docs, ≥2 users) → blockquote");
  assert(provHighCorr.disclaimer !== null, "provisional + corroborated → has disclaimer");

  const provLowCorr = await getDisputeLetterTreatment({
    backendConfidence: "provisional",
    canonicalPlanId: "c1",
    fieldName: "in_deductible_individual",
    serviceSlug: null,
    value: 1500,
    lookupCorroboration: async () => ({ distinctDocuments: 1, distinctUsers: 1 }),
  });
  assert(provLowCorr.mode === "hide", "provisional + low corroboration → hide");

  const provNoLookup = await getDisputeLetterTreatment({ backendConfidence: "provisional" });
  assert(provNoLookup.mode === "hide", "provisional + no lookup fn → hide (graceful degradation)");
}

// ── Orchestrator: evaluateSmartSkipEligibility ──────────────────────────────
console.log("\n[12] Orchestrator: evaluateSmartSkipEligibility");
const greenEligibility = evaluateSmartSkipEligibility({
  validityInput: baseValidity,
  layer2Stable: true,
  doctypePromoted: true,
  forcedReparseInput: {
    ...baseForce,
    randomFn: () => 0.99, // miss sample
  },
});
assert(greenEligibility.eligible === true, "all green → eligible");
assert(greenEligibility.decisionLayer === "all_pass", "decisionLayer === all_pass");

const layer1Fail = evaluateSmartSkipEligibility({
  validityInput: { ...baseValidity, selfCheckPassRate: 0.5 },
  layer2Stable: true,
  doctypePromoted: true,
  forcedReparseInput: baseForce,
});
assert(layer1Fail.eligible === false, "Layer 1 fail → NOT eligible");
assert(layer1Fail.decisionLayer === "layer1", "decisionLayer === layer1");

const layer2Fail = evaluateSmartSkipEligibility({
  validityInput: baseValidity,
  layer2Stable: false,
  doctypePromoted: true,
  forcedReparseInput: baseForce,
});
assert(layer2Fail.eligible === false, "Layer 2 fail → NOT eligible");
assert(layer2Fail.decisionLayer === "layer2", "decisionLayer === layer2");

const layer3Fail = evaluateSmartSkipEligibility({
  validityInput: baseValidity,
  layer2Stable: true,
  doctypePromoted: false,
  forcedReparseInput: baseForce,
});
assert(layer3Fail.eligible === false, "Layer 3 fail → NOT eligible");
assert(layer3Fail.decisionLayer === "layer3", "decisionLayer === layer3");

const layer5Fail = evaluateSmartSkipEligibility({
  validityInput: baseValidity,
  layer2Stable: true,
  doctypePromoted: true,
  forcedReparseInput: { ...baseForce, isAdmin: true },
});
assert(layer5Fail.eligible === false, "Layer 5 (admin) fail → NOT eligible");
assert(layer5Fail.decisionLayer === "layer5", "decisionLayer === layer5");

// ── Flag key constants ──────────────────────────────────────────────────────
console.log("\n[13] Flag key constants");
assert(CF40_V4_FLAG_KEY === "cf40_v4_algorithm", "CF40_V4_FLAG_KEY === 'cf40_v4_algorithm'");
assert(
  ADMIN_ATTESTATION_FLAG_KEY === "admin_attestation_enabled",
  "ADMIN_ATTESTATION_FLAG_KEY === 'admin_attestation_enabled'",
);

// Spot-check scale thresholds are present + sensible.
console.log("\n[14] Scale threshold integrity");
assert(CORROBORATION_THRESHOLDS.cold_start.distinctUsers === 3, "cold_start distinctUsers=3");
assert(CORROBORATION_THRESHOLDS.large.asns === 5, "large asns=5");
assert(REPARSE_SAMPLING.cold_start.sampleRate === 0.25, "cold_start sample rate 0.25");
assert(REPARSE_SAMPLING.large.sampleRate === 0.005, "large sample rate 0.005");

runDisputeTests()
  .then(() => {
    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
    if (fail > 0) process.exit(1);
  })
  .catch((err) => {
    console.error("Async test runner failed:", err);
    process.exit(1);
  });
