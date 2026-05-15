/**
 * S92 Stage 0 baseline harness — runs the CURRENT `parseSBC()` (src/lib/sbc/parser.ts)
 * against the 7 SBC fixtures used by `test-plan-doc-haiku-fixtures.ts`. Outputs the same
 * shape so per-fixture cite-grade rates can be compared head-to-head:
 *   - plan_doc parser (target replacement) — `npx tsx scripts/test-plan-doc-haiku-fixtures.ts --fixture sbc-`
 *   - sbc parser (incumbent baseline) — this script
 *
 * The Subplan's Stage 0 gate is: plan_doc parser must MEET OR EXCEED the SBC parser's
 * services-cite-grade rate on every fixture before the unified-parser sunset (Stage 3)
 * can ship. Andrew direction 2026-05-14: "Match or exceed previous baseline."
 *
 * Usage:
 *   npx tsx scripts/test-sbc-haiku-fixtures.ts                  # all 7
 *   npx tsx scripts/test-sbc-haiku-fixtures.ts --fixture wha    # single fixture
 */

import { config } from "dotenv";
import { resolve } from "path";
import * as fs from "fs";
import { parseSBC } from "../src/lib/sbc/parser";
import type {
  SBCHaikuParseResult,
  SBCPatternP8Provenance,
} from "../src/lib/sbc/types";

config({ path: resolve(__dirname, "../.env.local"), override: true });

interface Fixture {
  id: string;
  path: string;
}

const ALL_FIXTURES: Fixture[] = [
  {
    id: "sbc-ambetter-ca-2024-bronze-60-hdhp",
    path: "tests/fixtures/sbcs/ambetter-ca-2024-bronze-60-hdhp/source.txt",
  },
  {
    id: "sbc-ambetter-ca-2024-silver-87",
    path: "tests/fixtures/sbcs/ambetter-ca-2024-silver-87/source.txt",
  },
  {
    id: "sbc-ambetter-ca-2024-gold-80",
    path: "tests/fixtures/sbcs/ambetter-ca-2024-gold-80/source.txt",
  },
  {
    id: "sbc-blue-shield-ca-2025-bronze-60-ppo",
    path: "tests/fixtures/sbcs/blue-shield-ca-2025-bronze-60-ppo/source.txt",
  },
  {
    id: "sbc-blue-shield-ca-2025-silver-70-ppo",
    path: "tests/fixtures/sbcs/blue-shield-ca-2025-silver-70-ppo/source.txt",
  },
  {
    id: "sbc-blue-shield-ca-2026-silver-70-hmo",
    path: "tests/fixtures/sbcs/blue-shield-ca-2026-silver-70-hmo/source.txt",
  },
  {
    id: "sbc-wha-ca-2026-premier-hmo",
    path: "tests/fixtures/sbcs/wha-ca-2026-premier-hmo/source.txt",
  },
];

// Subset of SBCPlanIdentity fields that overlap with PlanDocPlanIdentity so cite-grade
// comparisons stay apples-to-apples with the plan_doc harness. The SBC shape has 22
// fields total; the plan_doc shape has 15. The 13 below are the intersection — both
// parsers extract them, so comparing populated/cite-grade rates against this list is
// fair to both. Excludes plan_doc-only fields (groupNumber, networkType) and SBC-only
// fields (referralRequired, minimumValueStandard, rxDeductible*, isAcaCompliant, etc.).
const COMMON_IDENTITY_KEYS = [
  "planName",
  "insurerName",
  "planType",
  "metalTier",
  "planYear",
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
  inputBytes: number;
  durationMs: number;
  planIdentityFieldsPopulated: number;
  planIdentityCiteGradeCount: number;
  servicesCount: number;
  servicesCiteGradeCount: number;
  otherCoveredCount: number;
  otherCoveredCiteGradeCount: number;
  excludedCount: number;
  appealsContactsCount: number;
  totalCostUsd: number;
  haikuTokensInput: number;
  haikuTokensOutput: number;
  warningsCount: number;
  warningsSample: string[];
  errorMessage?: string;
}

function isCiteGrade(p8: SBCPatternP8Provenance | undefined): boolean {
  if (!p8) return false;
  return p8.source_excerpt_verified === "verified" && p8.source_section_verified === true;
}

function deriveMetrics(
  fixture: Fixture,
  inputBytes: number,
  durationMs: number,
  result: SBCHaikuParseResult,
): FixtureMetrics {
  let planIdentityFieldsPopulated = 0;
  let planIdentityCiteGradeCount = 0;
  for (const key of COMMON_IDENTITY_KEYS) {
    const field = result.planIdentity[key];
    if (field?.value !== null && field?.value !== undefined) {
      planIdentityFieldsPopulated += 1;
    }
    if (isCiteGrade(field?.patternP8)) {
      planIdentityCiteGradeCount += 1;
    }
  }

  let servicesCiteGradeCount = 0;
  for (const svc of result.services) {
    if (isCiteGrade(svc.patternP8)) servicesCiteGradeCount += 1;
  }
  let otherCoveredCiteGradeCount = 0;
  for (const svc of result.otherCoveredServices) {
    if (isCiteGrade(svc.patternP8)) otherCoveredCiteGradeCount += 1;
  }

  return {
    fixtureId: fixture.id,
    inputBytes,
    durationMs,
    planIdentityFieldsPopulated,
    planIdentityCiteGradeCount,
    servicesCount: result.services.length,
    servicesCiteGradeCount,
    otherCoveredCount: result.otherCoveredServices.length,
    otherCoveredCiteGradeCount,
    excludedCount: result.excludedServices.length,
    appealsContactsCount: result.appealsContacts.length,
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
      inputBytes: 0,
      durationMs: 0,
      planIdentityFieldsPopulated: 0,
      planIdentityCiteGradeCount: 0,
      servicesCount: 0,
      servicesCiteGradeCount: 0,
      otherCoveredCount: 0,
      otherCoveredCiteGradeCount: 0,
      excludedCount: 0,
      appealsContactsCount: 0,
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
    const result = await parseSBC({
      ocrText,
      extractionMethod: "pdftotext",
      enqueueContext: null,
    });
    const durationMs = Date.now() - startedAt;
    return deriveMetrics(fixture, inputBytes, durationMs, result);
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      fixtureId: fixture.id,
      inputBytes,
      durationMs,
      planIdentityFieldsPopulated: 0,
      planIdentityCiteGradeCount: 0,
      servicesCount: 0,
      servicesCiteGradeCount: 0,
      otherCoveredCount: 0,
      otherCoveredCiteGradeCount: 0,
      excludedCount: 0,
      appealsContactsCount: 0,
      totalCostUsd: 0,
      haikuTokensInput: 0,
      haikuTokensOutput: 0,
      warningsCount: 0,
      warningsSample: [],
      errorMessage: msg,
    };
  }
}

function getFilteredFixtures(): Fixture[] {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--fixture");
  if (idx < 0 || idx + 1 >= args.length) return ALL_FIXTURES;
  const filter = args[idx + 1].toLowerCase();
  const matched = ALL_FIXTURES.filter((f) => f.id.toLowerCase().includes(filter));
  if (matched.length === 0) {
    console.warn(`[harness] --fixture "${filter}" matched no fixtures. Available ids:`);
    for (const f of ALL_FIXTURES) console.warn(`  - ${f.id}`);
  } else {
    console.log(`[harness] --fixture "${filter}" matched ${matched.length} of ${ALL_FIXTURES.length}: ${matched.map((f) => f.id).join(", ")}`);
  }
  return matched;
}

function formatRow(label: string, value: string | number | null | undefined): string {
  const v = value === null || value === undefined ? "—" : String(value);
  return `    ${label.padEnd(38)} ${v}`;
}

function printFixtureReport(m: FixtureMetrics): void {
  console.log("");
  console.log(`──── ${m.fixtureId} (sbc, current parser) ────`);
  if (m.errorMessage) {
    console.log(`    ❌ ERROR: ${m.errorMessage}`);
    return;
  }
  const totalServices = m.servicesCount + m.otherCoveredCount;
  const totalCite = m.servicesCiteGradeCount + m.otherCoveredCiteGradeCount;
  const totalCiteRate = totalServices > 0 ? (totalCite / totalServices) * 100 : 0;
  console.log(formatRow("input bytes", m.inputBytes.toLocaleString()));
  console.log(formatRow("duration ms", m.durationMs.toLocaleString()));
  console.log(formatRow("planIdentity populated (of 13)", `${m.planIdentityFieldsPopulated} / 13`));
  console.log(formatRow("planIdentity cite-grade", `${m.planIdentityCiteGradeCount} / 13`));
  console.log(formatRow("services count (common_medical)", m.servicesCount));
  console.log(formatRow("services cite-grade", `${m.servicesCiteGradeCount} / ${m.servicesCount}`));
  console.log(formatRow("otherCovered count", m.otherCoveredCount));
  console.log(formatRow("otherCovered cite-grade", `${m.otherCoveredCiteGradeCount} / ${m.otherCoveredCount}`));
  console.log(formatRow("COMBINED services count", totalServices));
  console.log(formatRow("COMBINED cite-grade", `${totalCite} / ${totalServices} (${totalCiteRate.toFixed(1)}%)`));
  console.log(formatRow("excluded services", m.excludedCount));
  console.log(formatRow("appeals contacts", m.appealsContactsCount));
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
  console.log("════════ AGGREGATE (current SBC parser baseline) ════════");
  const valid = metrics.filter((m) => !m.errorMessage);
  console.log(`Total fixtures: ${metrics.length} (${valid.length} parsed)`);
  if (valid.length === 0) return;

  const totalCost = valid.reduce((s, m) => s + m.totalCostUsd, 0);
  const totalDurationMs = valid.reduce((s, m) => s + m.durationMs, 0);
  const totalServices = valid.reduce((s, m) => s + m.servicesCount + m.otherCoveredCount, 0);
  const totalCite = valid.reduce(
    (s, m) => s + m.servicesCiteGradeCount + m.otherCoveredCiteGradeCount,
    0,
  );
  const avgServices = totalServices / valid.length;
  const avgCiteRate = totalServices > 0 ? (totalCite / totalServices) * 100 : 0;
  const avgPlanIdentityRecall =
    valid.reduce((s, m) => s + m.planIdentityFieldsPopulated, 0) / valid.length;
  const avgPlanIdentityCiteGrade =
    valid.reduce((s, m) => s + m.planIdentityCiteGradeCount, 0) / valid.length;

  console.log(formatRow("total Haiku cost USD", `$${totalCost.toFixed(4)}`));
  console.log(formatRow("total duration", `${(totalDurationMs / 1000).toFixed(2)}s`));
  console.log(formatRow("avg planIdentity populated", `${avgPlanIdentityRecall.toFixed(1)} / 13 (${((avgPlanIdentityRecall / 13) * 100).toFixed(1)}%)`));
  console.log(formatRow("avg planIdentity cite-grade", `${avgPlanIdentityCiteGrade.toFixed(1)} / 13 (${((avgPlanIdentityCiteGrade / 13) * 100).toFixed(1)}%)`));
  console.log(formatRow("avg COMBINED services / fixture", avgServices.toFixed(1)));
  console.log(formatRow("avg COMBINED cite-grade", `${avgCiteRate.toFixed(1)}%`));
}

async function main(): Promise<void> {
  const repoRoot = resolve(__dirname, "..");
  const FIXTURES = getFilteredFixtures();
  console.log("S92 Stage 0 baseline — current SBC parser efficacy on the 7 SBC fixtures");
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
