/**
 * S72 commit 2 — empirical efficacy harness for the new Haiku-first plan_doc parser.
 *
 * Runs `parsePlanDocumentHaiku()` against:
 *   - 3 EOC fixtures (Blue Shield CA Silver 70 PPO / Aetna Medicare PPO / Kaiser
 *     Permanente CA Traditional HMO) — proxy for plan_doc shape per Subplan §5
 *     EOC regression check (Q-S72-2 (b) mitigation).
 *   - 2 Cigna plan-document text inputs from /tmp/s72-test-fixtures/ (pdftotext
 *     of /Users/andrewullmann/Downloads/{Cigna Plan Benefits,current_cigna_plan}.pdf).
 *
 * Reports per-fixture:
 *   - segmentationUsed (regex_only / regex_plus_haiku_discovery / haiku_discovery_only / preamble_only)
 *   - dispatchedSections (which of the 3 priority sections actually ran Haiku)
 *   - planIdentity field-population count (of 15 fields)
 *   - services count + cite-grade-passing services count
 *   - accessInstructions presence + sub-field population
 *   - totalCostUsd / haikuTokensInput / haikuTokensOutput
 *   - parseWarnings count + first 3 warnings
 *
 * Aggregate summary at the end: total cost, time, avg recall, cost-per-fixture.
 *
 * Usage: npx tsx scripts/test-plan-doc-haiku-fixtures.ts
 */

import { config } from "dotenv";
import { resolve } from "path";
import * as fs from "fs";
import { parsePlanDocumentHaiku } from "../src/lib/plan_doc/parser";
import type {
  PlanDocHaikuParseResult,
  PlanDocPatternP8Provenance,
} from "../src/lib/plan_doc/types";

config({ path: resolve(__dirname, "../.env.local"), override: true });

interface Fixture {
  id: string;
  path: string;
  kind: "eoc_proxy" | "plan_doc_real";
}

const FIXTURES: Fixture[] = [
  // EOC proxies (Subplan §5 Q-S72-2 (b) regression check)
  {
    id: "eoc-blue-shield-ca-silver-70-ppo",
    path: "tests/fixtures/eocs/blue-shield-ca-2025-silver-70-ppo/source.txt",
    kind: "eoc_proxy",
  },
  {
    id: "eoc-aetna-medicare-ppo",
    path: "tests/fixtures/eocs/aetna-medicare-2025-ppo/source.txt",
    kind: "eoc_proxy",
  },
  {
    id: "eoc-kaiser-permanente-traditional-hmo",
    path: "tests/fixtures/eocs/kaiser-permanente-ca-2025-traditional-hmo/source.txt",
    kind: "eoc_proxy",
  },
  // Cigna plan-doc real (user PROD slate)
  {
    id: "cigna-plan-benefits",
    path: "/tmp/s72-test-fixtures/cigna-plan-benefits.txt",
    kind: "plan_doc_real",
  },
  {
    id: "cigna-current",
    path: "/tmp/s72-test-fixtures/cigna-current.txt",
    kind: "plan_doc_real",
  },
];

const PLAN_IDENTITY_FIELD_KEYS = [
  "planName",
  "insurerName",
  "planType",
  "metalTier",
  "planYear",
  "groupNumber",
  "networkType",
  "deductibleIndividual",
  "deductibleFamily",
  "oopMaxIndividual",
  "oopMaxFamily",
  "outDeductibleIndividual",
  "outDeductibleFamily",
  "outOopMaxIndividual",
  "outOopMaxFamily",
] as const;

interface FixtureMetrics {
  fixtureId: string;
  fixtureKind: Fixture["kind"];
  inputBytes: number;
  durationMs: number;
  segmentationUsed: PlanDocHaikuParseResult["segmentationUsed"];
  dispatchedSections: string[];
  planIdentityFieldsPopulated: number; // of 15
  planIdentityCiteGradeCount: number; // verified+section_verified
  servicesCount: number;
  servicesCiteGradeCount: number; // services with verified+section_verified P-8
  servicesWithHowToAccess: number;
  accessInstructionsPresent: boolean;
  accessInstructionsCustomerServicePhone: string | null;
  accessInstructionsNetworkFinderUrl: string | null;
  accessInstructionsDomainContactsCount: number;
  totalCostUsd: number;
  haikuTokensInput: number;
  haikuTokensOutput: number;
  warningsCount: number;
  warningsSample: string[];
  errorMessage?: string;
}

function isCiteGrade(p8: PlanDocPatternP8Provenance | undefined): boolean {
  if (!p8) return false;
  return p8.source_excerpt_verified === "verified" && p8.source_section_verified === true;
}

function deriveMetrics(
  fixture: Fixture,
  inputBytes: number,
  durationMs: number,
  result: PlanDocHaikuParseResult,
): FixtureMetrics {
  let planIdentityFieldsPopulated = 0;
  let planIdentityCiteGradeCount = 0;
  for (const key of PLAN_IDENTITY_FIELD_KEYS) {
    const field = result.planIdentity[key];
    if (field?.value !== null && field?.value !== undefined) {
      planIdentityFieldsPopulated += 1;
    }
    if (isCiteGrade(field?.patternP8)) {
      planIdentityCiteGradeCount += 1;
    }
  }

  let servicesCiteGradeCount = 0;
  let servicesWithHowToAccess = 0;
  for (const svc of result.services) {
    if (isCiteGrade(svc.patternP8)) servicesCiteGradeCount += 1;
    if (svc.howToAccess && svc.howToAccess.length > 0) servicesWithHowToAccess += 1;
  }

  const ai = result.accessInstructions;

  return {
    fixtureId: fixture.id,
    fixtureKind: fixture.kind,
    inputBytes,
    durationMs,
    segmentationUsed: result.segmentationUsed,
    dispatchedSections: result.dispatchedSections,
    planIdentityFieldsPopulated,
    planIdentityCiteGradeCount,
    servicesCount: result.services.length,
    servicesCiteGradeCount,
    servicesWithHowToAccess,
    accessInstructionsPresent: ai !== null,
    accessInstructionsCustomerServicePhone: ai?.customerServicePhone.value ?? null,
    accessInstructionsNetworkFinderUrl: ai?.networkFinderUrl.value ?? null,
    accessInstructionsDomainContactsCount: ai ? Object.keys(ai.domainContacts).length : 0,
    totalCostUsd: result.costUsd,
    haikuTokensInput: result.haikuTokensInput,
    haikuTokensOutput: result.haikuTokensOutput,
    warningsCount: result.parseWarnings.length,
    warningsSample: result.parseWarnings.slice(0, 3),
  };
}

async function runFixture(fixture: Fixture, repoRoot: string): Promise<FixtureMetrics> {
  const absolutePath = fixture.path.startsWith("/")
    ? fixture.path
    : resolve(repoRoot, fixture.path);

  if (!fs.existsSync(absolutePath)) {
    return {
      fixtureId: fixture.id,
      fixtureKind: fixture.kind,
      inputBytes: 0,
      durationMs: 0,
      segmentationUsed: "preamble_only",
      dispatchedSections: [],
      planIdentityFieldsPopulated: 0,
      planIdentityCiteGradeCount: 0,
      servicesCount: 0,
      servicesCiteGradeCount: 0,
      servicesWithHowToAccess: 0,
      accessInstructionsPresent: false,
      accessInstructionsCustomerServicePhone: null,
      accessInstructionsNetworkFinderUrl: null,
      accessInstructionsDomainContactsCount: 0,
      totalCostUsd: 0,
      haikuTokensInput: 0,
      haikuTokensOutput: 0,
      warningsCount: 0,
      warningsSample: [],
      errorMessage: `fixture file not found: ${absolutePath}`,
    };
  }

  const ocrText = fs.readFileSync(absolutePath, "utf-8");
  const inputBytes = Buffer.byteLength(ocrText, "utf-8");
  const startedAt = Date.now();

  try {
    const result = await parsePlanDocumentHaiku({
      ocrText,
      documentId: `harness_${fixture.id}`,
      extractionMethod: "pdftotext",
    });
    const durationMs = Date.now() - startedAt;
    return deriveMetrics(fixture, inputBytes, durationMs, result);
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      fixtureId: fixture.id,
      fixtureKind: fixture.kind,
      inputBytes,
      durationMs,
      segmentationUsed: "preamble_only",
      dispatchedSections: [],
      planIdentityFieldsPopulated: 0,
      planIdentityCiteGradeCount: 0,
      servicesCount: 0,
      servicesCiteGradeCount: 0,
      servicesWithHowToAccess: 0,
      accessInstructionsPresent: false,
      accessInstructionsCustomerServicePhone: null,
      accessInstructionsNetworkFinderUrl: null,
      accessInstructionsDomainContactsCount: 0,
      totalCostUsd: 0,
      haikuTokensInput: 0,
      haikuTokensOutput: 0,
      warningsCount: 0,
      warningsSample: [],
      errorMessage: msg,
    };
  }
}

function formatRow(label: string, value: string | number | null | undefined): string {
  const v = value === null || value === undefined ? "—" : String(value);
  return `    ${label.padEnd(38)} ${v}`;
}

function printFixtureReport(m: FixtureMetrics): void {
  console.log("");
  console.log(`──── ${m.fixtureId} (${m.fixtureKind}) ────`);
  if (m.errorMessage) {
    console.log(`    ❌ ERROR: ${m.errorMessage}`);
    return;
  }
  console.log(formatRow("input bytes", m.inputBytes.toLocaleString()));
  console.log(formatRow("duration ms", m.durationMs.toLocaleString()));
  console.log(formatRow("segmentation used", m.segmentationUsed));
  console.log(formatRow("dispatched sections", m.dispatchedSections.length === 0 ? "(none)" : m.dispatchedSections.join(", ")));
  console.log(formatRow("planIdentity populated", `${m.planIdentityFieldsPopulated} / 15`));
  console.log(formatRow("planIdentity cite-grade", `${m.planIdentityCiteGradeCount} / 15`));
  console.log(formatRow("services count", m.servicesCount));
  console.log(formatRow("services cite-grade", `${m.servicesCiteGradeCount} / ${m.servicesCount}`));
  console.log(formatRow("services with howToAccess", `${m.servicesWithHowToAccess} / ${m.servicesCount}`));
  console.log(formatRow("accessInstructions present", m.accessInstructionsPresent ? "yes" : "no"));
  if (m.accessInstructionsPresent) {
    console.log(formatRow("  customer service phone", m.accessInstructionsCustomerServicePhone));
    console.log(formatRow("  network finder URL", m.accessInstructionsNetworkFinderUrl));
    console.log(formatRow("  domain contacts count", m.accessInstructionsDomainContactsCount));
  }
  console.log(formatRow("total cost USD", `$${m.totalCostUsd.toFixed(4)}`));
  console.log(formatRow("haiku tokens (in / out)", `${m.haikuTokensInput.toLocaleString()} / ${m.haikuTokensOutput.toLocaleString()}`));
  console.log(formatRow("warnings count", m.warningsCount));
  if (m.warningsSample.length > 0) {
    console.log(`        sample warnings:`);
    for (const w of m.warningsSample) {
      console.log(`          - ${w.slice(0, 120)}`);
    }
  }
}

function printAggregate(metrics: FixtureMetrics[]): void {
  console.log("");
  console.log("════════ AGGREGATE ════════");
  const valid = metrics.filter((m) => !m.errorMessage);
  const failed = metrics.filter((m) => m.errorMessage);
  console.log(`Total fixtures: ${metrics.length} (${valid.length} parsed, ${failed.length} errored)`);
  if (valid.length === 0) {
    console.log("No valid fixtures parsed; skipping aggregate metrics.");
    return;
  }

  const totalCost = valid.reduce((s, m) => s + m.totalCostUsd, 0);
  const totalDurationMs = valid.reduce((s, m) => s + m.durationMs, 0);
  const totalInputTokens = valid.reduce((s, m) => s + m.haikuTokensInput, 0);
  const totalOutputTokens = valid.reduce((s, m) => s + m.haikuTokensOutput, 0);

  const avgPlanIdentityRecall =
    valid.reduce((s, m) => s + m.planIdentityFieldsPopulated, 0) / valid.length;
  const avgPlanIdentityCiteGrade =
    valid.reduce((s, m) => s + m.planIdentityCiteGradeCount, 0) / valid.length;
  const avgServices = valid.reduce((s, m) => s + m.servicesCount, 0) / valid.length;
  const avgServicesCiteGrade =
    valid.reduce((s, m) => s + m.servicesCiteGradeCount, 0) / valid.length;
  const accessInstructionsHitRate =
    valid.filter((m) => m.accessInstructionsPresent).length / valid.length;

  console.log(formatRow("total Haiku cost USD", `$${totalCost.toFixed(4)}`));
  console.log(formatRow("total duration", `${(totalDurationMs / 1000).toFixed(2)}s`));
  console.log(formatRow("total Haiku tokens (in / out)", `${totalInputTokens.toLocaleString()} / ${totalOutputTokens.toLocaleString()}`));
  console.log(formatRow("avg planIdentity populated", `${avgPlanIdentityRecall.toFixed(1)} / 15 (${((avgPlanIdentityRecall / 15) * 100).toFixed(1)}%)`));
  console.log(formatRow("avg planIdentity cite-grade", `${avgPlanIdentityCiteGrade.toFixed(1)} / 15 (${((avgPlanIdentityCiteGrade / 15) * 100).toFixed(1)}%)`));
  console.log(formatRow("avg services per fixture", avgServices.toFixed(1)));
  console.log(formatRow("avg services cite-grade", avgServicesCiteGrade.toFixed(1)));
  console.log(formatRow("accessInstructions hit rate", `${(accessInstructionsHitRate * 100).toFixed(0)}%`));

  if (failed.length > 0) {
    console.log("");
    console.log("ERRORED FIXTURES:");
    for (const f of failed) {
      console.log(`  ${f.fixtureId}: ${f.errorMessage}`);
    }
  }
}

async function main(): Promise<void> {
  const repoRoot = resolve(__dirname, "..");
  console.log("S72 plan_doc Haiku-first parser empirical efficacy harness");
  console.log(`Repo root: ${repoRoot}`);
  console.log(`Fixtures: ${FIXTURES.length}`);

  const metrics: FixtureMetrics[] = [];
  for (const fixture of FIXTURES) {
    console.log(`\nRunning ${fixture.id}...`);
    const m = await runFixture(fixture, repoRoot);
    metrics.push(m);
    printFixtureReport(m);
  }

  printAggregate(metrics);
}

void main().catch((err) => {
  console.error("Harness failed:", err);
  process.exit(1);
});
