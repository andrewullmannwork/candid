/**
 * S177 — Ship Gate G4 fixture for the RC-5 cost-sharing recall sentinel.
 *
 * Locks the `cost_sharing_gap` failure-mode behavior added to
 * `src/lib/plan_doc/parse-quality.ts` (computeParseQuality):
 *
 *   - fires when in-network individual deductible OR oop-max is null,
 *   - fires EVEN at score >= 0.80 (the score-gated blind spot it exists to close),
 *   - does NOT false-fire on a genuine $0 plan ($0 is stored as 0, not null),
 *   - yields to total-extraction failures (services_zero / extraction_failed),
 *   - does not disturb the pre-existing peo_sponsor_confusion path.
 *
 * Manually runnable (CI wiring is a follow-up obligation per Ship Gate G4):
 *   set -a && source .env.local && set +a   # not required; pure/no network
 *   npx tsx scripts/parse-quality-cost-sharing-fixture.ts
 */

import { computeParseQuality, type ParseQualityFailureMode } from "../src/lib/plan_doc/parse-quality";
import type {
  PlanDocField,
  PlanDocHaikuParseResult,
  PlanDocPatternP8Provenance,
  PlanDocPlanIdentity,
  PlanDocService,
} from "../src/lib/plan_doc/types";

function p8(verified: boolean): PlanDocPatternP8Provenance {
  return {
    source_excerpt: verified ? "verbatim supporting excerpt" : "",
    source_excerpt_verified: verified ? "verified" : "not_found",
    source_excerpt_extraction_method: "native_pdf_text",
    source_section_hint: "plan_identity",
    source_section_verified: verified,
  };
}

function f<T>(value: T, verified = true): PlanDocField<T> {
  return { value, patternP8: p8(verified), haikuConfidence: 0.95 };
}

/** A fully-populated plan-identity; override ded/oop/insurer/populated per case. */
function pi(opts: { ded?: number | null; oop?: number | null; insurer?: string | null; sparse?: boolean } = {}): PlanDocPlanIdentity {
  const ded = opts.ded === undefined ? 2500 : opts.ded;
  const oop = opts.oop === undefined ? 8000 : opts.oop;
  const insurer = opts.insurer === undefined ? "Test Insurer" : opts.insurer;
  // sparse=true nulls the soft fields so planIdentityPopulated < 8 (plan_identity_low territory).
  const soft = <T>(v: T): PlanDocField<T | null> => f<T | null>(opts.sparse ? null : v);
  return {
    planName: soft<string>("Test Plan"),
    insurerName: f<string | null>(insurer),
    planType: soft<string>("PPO"),
    metalTier: soft<string>("Silver"),
    planYear: soft<number>(2026),
    groupNumber: soft<string>("G123"),
    networkType: soft<string>("PPO"),
    deductibleIndividual: f<number | null>(ded),
    deductibleFamily: soft<number>(5000),
    oopMaxIndividual: f<number | null>(oop),
    oopMaxFamily: soft<number>(16000),
    outDeductibleIndividual: soft<number>(5000),
    outDeductibleFamily: soft<number>(10000),
    outOopMaxIndividual: soft<number>(16000),
    outOopMaxFamily: soft<number>(32000),
    isAcaCompliant: f<boolean | null>(true),
    acaComplianceBasis: soft<string>("explicit_attestation"),
  };
}

function svc(citeGrade: boolean): PlanDocService {
  return {
    serviceSlug: "primary_care_visit",
    placeOfService: "office",
    inCopay: 25,
    inCoinsurance: null,
    inDeductibleApplies: false,
    inCopayWaiverCondition: null,
    inCostDescription: "$25 copay",
    outCopay: null,
    outCoinsurance: null,
    outDeductibleApplies: null,
    outCostDescription: "Not covered",
    oonPaidAtInNetwork: false,
    annualLimit: null,
    annualLimitValue: null,
    priorAuthRequired: false,
    penaltyNoPrecert: null,
    covered: true,
    coverageConditions: null,
    supplyLimitDays: null,
    homeDeliveryCopay: null,
    stepTherapyRequired: null,
    notes: null,
    confidence: 0.9,
    sourceExcerpt: null,
    sourcePage: null,
    patternP8: p8(citeGrade),
    haikuConfidence: 0.9,
    howToAccess: null,
    sourceRowIndex: null,
  };
}

function mkResult(planIdentity: PlanDocPlanIdentity, services: PlanDocService[], warnings: string[] = []): PlanDocHaikuParseResult {
  return {
    planIdentity,
    services,
    accessInstructions: null,
    parseWarnings: warnings,
    haikuTokensInput: 1000,
    haikuTokensOutput: 500,
    haikuCacheCreateTokens: 0,
    haikuCacheReadTokens: 0,
    costUsd: 0.1,
    parseStrategyV2: true,
    dispatchedSections: ["plan_identity", "services_cost_sharing"],
    segmentationUsed: "regex_only",
  };
}

const goodServices = [svc(true), svc(true), svc(true)]; // cite-grade → high score
const weakServices = [svc(false)]; // not cite-grade → low score

interface Case {
  name: string;
  result: PlanDocHaikuParseResult;
  wantFailureMode: ParseQualityFailureMode | null;
  wantHighScore?: boolean; // assert score >= 0.80 to prove the decoupling
}

const CASES: Case[] = [
  {
    name: "ded null + good services → cost_sharing_gap at HIGH score (decoupling)",
    result: mkResult(pi({ ded: null }), goodServices),
    wantFailureMode: "cost_sharing_gap",
    wantHighScore: true,
  },
  {
    name: "oop null + good services → cost_sharing_gap at HIGH score",
    result: mkResult(pi({ oop: null }), goodServices),
    wantFailureMode: "cost_sharing_gap",
    wantHighScore: true,
  },
  {
    name: "both ded+oop null + good services → cost_sharing_gap",
    result: mkResult(pi({ ded: null, oop: null }), goodServices),
    wantFailureMode: "cost_sharing_gap",
  },
  {
    name: "$0 plan (ded=0, oop=0) + good services → NO flag (must not false-fire on $0)",
    result: mkResult(pi({ ded: 0, oop: 0 }), goodServices),
    wantFailureMode: null,
  },
  {
    name: "ded+oop populated + good services → NO flag",
    result: mkResult(pi({ ded: 2500, oop: 8000 }), goodServices),
    wantFailureMode: null,
  },
  {
    name: "both null + ZERO services → services_zero wins (total failure > cost_sharing_gap)",
    result: mkResult(pi({ ded: null, oop: null }), []),
    wantFailureMode: "services_zero",
  },
  {
    name: "ded null + weak services (low score) → cost_sharing_gap in the <0.80 chain",
    result: mkResult(pi({ ded: null }), weakServices),
    wantFailureMode: "cost_sharing_gap",
  },
  {
    name: "PEO insurer + ded/oop populated + low score → peo_sponsor_confusion (no regression)",
    result: mkResult(pi({ insurer: "TriNet HR Corporation" }), weakServices),
    wantFailureMode: "peo_sponsor_confusion",
  },
];

let pass = 0;
let fail = 0;
for (const c of CASES) {
  const q = computeParseQuality(c.result, "federal_sbc_8page");
  const okMode = q.failureMode === c.wantFailureMode;
  const okScore = c.wantHighScore === undefined ? true : q.score >= 0.8;
  const okSig =
    c.wantFailureMode === null
      ? q.signature === null
      : q.signature === `federal_sbc_8page::${c.wantFailureMode}`;
  const ok = okMode && okScore && okSig;
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${c.name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${c.name}`);
    console.log(`      got failureMode=${q.failureMode} score=${q.score} signature=${q.signature}`);
    console.log(`      want failureMode=${c.wantFailureMode}${c.wantHighScore ? " score>=0.80" : ""}`);
  }
}

console.log(`\n[parse-quality cost_sharing_gap fixture] ${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
