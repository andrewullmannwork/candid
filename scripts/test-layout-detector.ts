/**
 * S92 — Quick sanity test for layout-detector.ts. Runs detectLayout() against
 * each fixture's source.txt and prints the detected layout + confidence + features.
 * Expected results below; harness flags any mismatch.
 *
 * Usage: npx tsx scripts/test-layout-detector.ts
 */

import * as fs from "fs";
import { resolve } from "path";
import { detectLayout, type PlanDocLayout } from "../src/lib/plan_doc/layout-detector";

const REPO_ROOT = resolve(__dirname, "..");

interface FixtureExpectation {
  path: string;
  expectedLayout: PlanDocLayout;
  minConfidence: number;
}

const FIXTURES: FixtureExpectation[] = [
  // 7 SBC fixtures — all should detect federal_sbc_* with confidence ≥ 0.7
  { path: "tests/fixtures/sbcs/ambetter-ca-2024-bronze-60-hdhp/source.txt", expectedLayout: "federal_sbc_8page", minConfidence: 0.7 },
  { path: "tests/fixtures/sbcs/ambetter-ca-2024-silver-87/source.txt", expectedLayout: "federal_sbc_csr_variant", minConfidence: 0.7 },
  { path: "tests/fixtures/sbcs/ambetter-ca-2024-gold-80/source.txt", expectedLayout: "federal_sbc_8page", minConfidence: 0.7 },
  { path: "tests/fixtures/sbcs/blue-shield-ca-2025-bronze-60-ppo/source.txt", expectedLayout: "federal_sbc_8page", minConfidence: 0.7 },
  { path: "tests/fixtures/sbcs/blue-shield-ca-2025-silver-70-ppo/source.txt", expectedLayout: "federal_sbc_8page", minConfidence: 0.7 },
  { path: "tests/fixtures/sbcs/blue-shield-ca-2026-silver-70-hmo/source.txt", expectedLayout: "federal_sbc_8page", minConfidence: 0.7 },
  { path: "tests/fixtures/sbcs/wha-ca-2026-premier-hmo/source.txt", expectedLayout: "federal_sbc_8page", minConfidence: 0.7 },
  // 3 EOC fixtures — should detect full_eoc_narrative or NOT federal_sbc_*
  { path: "tests/fixtures/eocs/blue-shield-ca-2025-silver-70-ppo/source.txt", expectedLayout: "full_eoc_narrative", minConfidence: 0.5 },
  { path: "tests/fixtures/eocs/aetna-medicare-2025-ppo/source.txt", expectedLayout: "full_eoc_narrative", minConfidence: 0.5 },
  { path: "tests/fixtures/eocs/kaiser-permanente-ca-2025-traditional-hmo/source.txt", expectedLayout: "full_eoc_narrative", minConfidence: 0.5 },
];

let pass = 0;
let fail = 0;

for (const fixture of FIXTURES) {
  const fullPath = resolve(REPO_ROOT, fixture.path);
  if (!fs.existsSync(fullPath)) {
    console.log(`⚠️  ${fixture.path} — file not found`);
    continue;
  }
  const text = fs.readFileSync(fullPath, "utf-8");
  const result = detectLayout(text);
  const ok =
    result.layout === fixture.expectedLayout && result.confidence >= fixture.minConfidence;
  const status = ok ? "✅" : "❌";
  console.log(
    `${status} ${fixture.path.replace("tests/fixtures/", "")} → ${result.layout}@${result.confidence.toFixed(2)} (expected ${fixture.expectedLayout}@≥${fixture.minConfidence})`,
  );
  if (result.features.length > 0) {
    console.log(`     features: ${result.features.join(", ")}`);
  }
  if (ok) pass++;
  else fail++;
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
