/**
 * One-shot diagnostic — runs parseEOC against Blue Shield and prints
 * failed-excerpt details inline. No DB query.
 *
 * Usage: npx tsx scripts/diagnose-bs-failures.ts
 */

import { config } from "dotenv";
import { resolve } from "path";
import * as fs from "fs";
import { parseEOC } from "../src/lib/eoc/parser";

config({ path: resolve(__dirname, "../.env.local"), override: true });

async function main() {
  const path = "tests/fixtures/eocs/blue-shield-ca-2025-silver-70-ppo/source.txt";
  const ocrText = fs.readFileSync(path, "utf-8");
  const result = await parseEOC(ocrText, { documentId: "diagnose", extractionMethod: "pdftotext" });

  console.log(`\n=== ${path} ===`);
  console.log(`Cost: $${result.total_cost_usd.toFixed(4)}`);
  console.log(`Sections: ${Object.keys(result.sections).join(", ")}`);

  let printed = 0;
  const showFailing = (label: string, item: { source_excerpt?: string; source_excerpt_verified?: string }, extra: Record<string, unknown>) => {
    if (printed >= 10) return;
    if (item.source_excerpt_verified !== "not_found" || !item.source_excerpt) return;
    console.log(`\n[${label}] verified=${item.source_excerpt_verified}`);
    for (const [k, v] of Object.entries(extra)) {
      console.log(`  ${k}: ${JSON.stringify(v).slice(0, 200)}`);
    }
    console.log(`  emitted excerpt: ${JSON.stringify(item.source_excerpt)}`);
    // Search for the first 30 chars of emitted excerpt in the source
    const probe = item.source_excerpt.slice(0, 40);
    const idx = ocrText.indexOf(probe);
    if (idx >= 0) {
      console.log(`  ⚠️  probe FOUND in source at idx ${idx}`);
      console.log(`     ctx: ${JSON.stringify(ocrText.slice(idx, idx + Math.min(item.source_excerpt.length, 200)))}`);
    } else {
      console.log(`  ❌ probe NOT in source — Haiku paraphrased or invented`);
    }
    printed++;
  };

  if (result.sections.definitions) {
    result.sections.definitions.data.definitions.forEach((d, i) => showFailing(`definitions[${i}]`, d, { term: d.term }));
  }
  if (result.sections.medical_necessity) {
    result.sections.medical_necessity.data.criteria.forEach((c, i) =>
      showFailing(`medical_necessity[${i}]`, c, { service: c.service_slug_hint, criteria: c.criteria_text?.slice(0, 100) }),
    );
  }
  if (result.sections.prior_auth_codes) {
    result.sections.prior_auth_codes.data.codes.forEach((c, i) =>
      showFailing(`prior_auth_codes[${i}]`, c, { code: c.billing_code, type: c.billing_code_type }),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
