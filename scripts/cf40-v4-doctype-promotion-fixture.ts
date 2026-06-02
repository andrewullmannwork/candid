/**
 * Ing-D.0a fixture — CF-40 v4 Layer 3 doctype-promotion decision.
 *
 * Exercises the PURE core (computeLayer3Inputs → decideDoctypePromotion) across
 * 8 seeded cases: 4 doc-types × {promote, not-promote}, covering every gate —
 * corroboration, supermajority, coverage — plus the admin-attested path (flag ON
 * promote / flag OFF no-promote). No DB; deterministic; manually runnable.
 *
 * Run:  npx tsx scripts/cf40-v4-doctype-promotion-fixture.ts
 *
 * Ship Gate G4 (block_ship_gate.md). CI wiring is the follow-up obligation; this
 * mirrors the established standalone-fixture pattern (Ing-K, Ing-B, soft-hyphen).
 * Sticky-promotion + set-once promoted_at (the IO-side UPSERT semantics) are
 * verified separately in the dev-integration smoke.
 */

import {
  computeLayer3Inputs,
  decideDoctypePromotion,
  type AggPlanRow,
  type AggUserTrust,
} from "@/lib/parser/cf40-v4/doctype-promotion-aggregator";
import {
  DOC_TYPE_COVERAGE_CONFIG,
  type PlanDocType,
} from "@/lib/parser/doctype-expected-counts";

const NOW = new Date("2026-06-02T00:00:00.000Z");
const DAY_MS = 86_400_000;

interface UploadSpec {
  id: string;
  verified?: boolean; // email + phone verified (organic corroboration)
  admin?: boolean; // admin uploader (admin-attested path)
  value: number; // plan-identity value (supermajority grouping)
  ageDays: number;
}

interface ScenarioSpec {
  docType: PlanDocType;
  uploads: UploadSpec[];
  extractionCount: number; // canonical lifetime → scale tier + supermajority threshold
  verifiedScalars: number; // # of the doc-type's expected scalars marked verified
  verifiedServiceCount: number;
  observedServiceCount: number; // per-upload service count
  adminAttestationEnabled: boolean;
}

function buildScenario(s: ScenarioSpec) {
  const expectedScalars = DOC_TYPE_COVERAGE_CONFIG[s.docType].expectedPlanIdentityScalars;
  const verifiedKeys = expectedScalars.slice(0, s.verifiedScalars);
  const fieldProvenance = Object.fromEntries(
    verifiedKeys.map((k) => [k, { source_excerpt_verified: "verified" }]),
  );

  const planRows: AggPlanRow[] = [];
  const userById = new Map<string, AggUserTrust>();
  const serviceCountByPlanId = new Map<string, number>();

  s.uploads.forEach((u, i) => {
    const planId = `plan-${i}`;
    planRows.push({
      planId,
      userId: u.id,
      createdAt: new Date(NOW.getTime() - u.ageDays * DAY_MS).toISOString(),
      fieldProvenance,
      identityValues: {
        in_deductible_individual: u.value,
        in_deductible_family: u.value,
        in_oop_max_individual: u.value,
        in_oop_max_family: u.value,
      },
    });
    userById.set(u.id, {
      isAdmin: u.admin === true,
      emailVerified: u.verified === true,
      phoneVerified: u.verified === true,
    });
    serviceCountByPlanId.set(planId, s.observedServiceCount);
  });

  const inputs = computeLayer3Inputs({
    docType: s.docType,
    planRows,
    userById,
    extractionCount: s.extractionCount,
    serviceCountByPlanId,
    verifiedServiceCount: s.verifiedServiceCount,
    now: NOW,
  });
  return decideDoctypePromotion(inputs, s.docType, s.adminAttestationEnabled);
}

// Three verified users across five uploads on five distinct days, one value —
// passes corroboration (≥3 users / ≥5 uploads / ≥3 days) + supermajority (1.0).
const ORGANIC_PASS: UploadSpec[] = [
  { id: "a", verified: true, value: 1000, ageDays: 0 },
  { id: "a", verified: true, value: 1000, ageDays: 1 },
  { id: "b", verified: true, value: 1000, ageDays: 2 },
  { id: "b", verified: true, value: 1000, ageDays: 3 },
  { id: "c", verified: true, value: 1000, ageDays: 4 },
];

interface Case {
  name: string;
  spec: ScenarioSpec;
  expectPromoted: boolean;
  expectEventType?: "pattern1_3_organic" | "admin_attested";
}

const CASES: Case[] = [
  {
    name: "1. SBC — organic PROMOTE (all gates pass)",
    spec: { docType: "sbc", uploads: ORGANIC_PASS, extractionCount: 5, verifiedScalars: 12, verifiedServiceCount: 8, observedServiceCount: 8, adminAttestationEnabled: true },
    expectPromoted: true,
    expectEventType: "pattern1_3_organic",
  },
  {
    name: "2. SBC — NOT promoted (corroboration: 1 user < 3)",
    spec: { docType: "sbc", uploads: [{ id: "a", verified: true, value: 1000, ageDays: 0 }], extractionCount: 1, verifiedScalars: 12, verifiedServiceCount: 8, observedServiceCount: 8, adminAttestationEnabled: true },
    expectPromoted: false,
  },
  {
    name: "3. EOC — organic PROMOTE",
    spec: { docType: "eoc", uploads: ORGANIC_PASS, extractionCount: 5, verifiedScalars: 12, verifiedServiceCount: 15, observedServiceCount: 15, adminAttestationEnabled: true },
    expectPromoted: true,
    expectEventType: "pattern1_3_organic",
  },
  {
    name: "4. EOC — NOT promoted (coverage below 0.75)",
    spec: { docType: "eoc", uploads: ORGANIC_PASS, extractionCount: 5, verifiedScalars: 2, verifiedServiceCount: 2, observedServiceCount: 15, adminAttestationEnabled: true },
    expectPromoted: false,
  },
  {
    name: "5. plan_document — organic PROMOTE (boundary coverage ≈0.667 ≥ 0.65)",
    spec: { docType: "plan_document", uploads: ORGANIC_PASS, extractionCount: 5, verifiedScalars: 8, verifiedServiceCount: 10, observedServiceCount: 15, adminAttestationEnabled: true },
    expectPromoted: true,
    expectEventType: "pattern1_3_organic",
  },
  {
    name: "6. plan_document — NOT promoted (supermajority 0.667 < 0.80 on split values)",
    spec: {
      docType: "plan_document",
      uploads: [
        { id: "a", verified: true, value: 1000, ageDays: 0 },
        { id: "a", verified: true, value: 1000, ageDays: 1 },
        { id: "b", verified: true, value: 1000, ageDays: 2 },
        { id: "b", verified: true, value: 1000, ageDays: 3 },
        { id: "c", verified: true, value: 2000, ageDays: 4 },
      ],
      extractionCount: 20, // 11–100 → supermajority threshold 0.80
      verifiedScalars: 12,
      verifiedServiceCount: 15,
      observedServiceCount: 15,
      adminAttestationEnabled: true,
    },
    expectPromoted: false,
  },
  {
    name: "7. education_doc — admin-attested PROMOTE (2 admin uploads, flag ON)",
    spec: {
      docType: "education_doc",
      uploads: [
        { id: "admin1", admin: true, value: 1000, ageDays: 0 },
        { id: "admin2", admin: true, value: 1000, ageDays: 1 },
      ],
      extractionCount: 2,
      verifiedScalars: 6,
      verifiedServiceCount: 6,
      observedServiceCount: 6,
      adminAttestationEnabled: true,
    },
    expectPromoted: true,
    expectEventType: "admin_attested",
  },
  {
    name: "8. education_doc — NOT promoted (admin attestation flag OFF)",
    spec: {
      docType: "education_doc",
      uploads: [
        { id: "admin1", admin: true, value: 1000, ageDays: 0 },
        { id: "admin2", admin: true, value: 1000, ageDays: 1 },
      ],
      extractionCount: 2,
      verifiedScalars: 6,
      verifiedServiceCount: 6,
      observedServiceCount: 6,
      adminAttestationEnabled: false,
    },
    expectPromoted: false,
  },
];

let failures = 0;
console.log("CF-40 v4 Ing-D.0a — doctype-promotion decision fixture\n");
for (const c of CASES) {
  const { result, eventType } = buildScenario(c.spec);
  const promotedOk = result.promoted === c.expectPromoted;
  const eventOk =
    !c.expectPromoted || !c.expectEventType || eventType === c.expectEventType;
  const pass = promotedOk && eventOk;
  if (!pass) failures += 1;
  const detail = result.promoted
    ? `promoted=${result.promoted} event=${eventType} coverage=${result.observed.coverageScore.toFixed(3)}`
    : `promoted=${result.promoted} reasons=[${result.failureReasons.join(", ")}] coverage=${result.observed.coverageScore.toFixed(3)}`;
  console.log(`${pass ? "✓ PASS" : "✗ FAIL"}  ${c.name}\n         ${detail}`);
}

console.log(`\n${CASES.length - failures}/${CASES.length} passed.`);
if (failures > 0) {
  console.error(`\n${failures} case(s) FAILED.`);
  process.exit(1);
}
console.log("All cases passed.");
