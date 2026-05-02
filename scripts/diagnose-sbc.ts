/**
 * Diagnostic — runs parseSBC on a single fixture + prints every emitted source_excerpt
 * with per-excerpt verification status. Identifies WHY excerpts fail verification.
 *
 * Usage: npx tsx scripts/diagnose-sbc.ts <fixture-name>
 *   e.g. npx tsx scripts/diagnose-sbc.ts blue-shield-ca-2025-silver-70-ppo
 */

import { config } from "dotenv";
import { resolve } from "path";
import * as fs from "fs";
import { parseSBC } from "../src/lib/sbc/parser";

config({ path: resolve(__dirname, "../.env.local"), override: true });

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[​-‍﻿]/g, "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const fixture = process.argv[2];
  if (!fixture) {
    console.error("Usage: npx tsx scripts/diagnose-sbc.ts <fixture-name>");
    process.exit(1);
  }
  const fixturePath = resolve(__dirname, `../tests/fixtures/sbcs/${fixture}`);
  const sourceText = fs.readFileSync(`${fixturePath}/source.txt`, "utf-8");
  console.log(`\n=== Diagnostic: ${fixture} (${sourceText.length} chars) ===\n`);

  const result = await parseSBC({ ocrText: sourceText, extractionMethod: "pdftotext" });

  const normalizedDoc = normalizeWhitespace(sourceText);

  function check(label: string, excerpt: string, verified: string, sectionVerified: boolean) {
    if (!excerpt) {
      console.log(`[empty]  ${label}`);
      return;
    }
    const inSource = sourceText.includes(excerpt);
    const inNorm = normalizedDoc.includes(normalizeWhitespace(excerpt));
    const status = inSource ? "✅BYTE" : inNorm ? "🟡NORM" : "❌MISS";
    const len = excerpt.length;
    const preview = excerpt.length > 70 ? excerpt.slice(0, 70) + "..." : excerpt;
    console.log(`${status} v=${verified.padEnd(15)} sv=${sectionVerified} (${len}c) ${label}: "${preview}"`);
  }

  console.log("--- Plan Identity ---");
  for (const key of Object.keys(result.planIdentity) as Array<keyof typeof result.planIdentity>) {
    const f = result.planIdentity[key];
    const p8 = f.patternP8;
    check(`planIdentity.${String(key)}=${JSON.stringify(f.value)}`, p8.source_excerpt, p8.source_excerpt_verified, p8.source_section_verified);
  }

  console.log("\n--- Services (common medical events): " + result.services.length + " ---");
  result.services.forEach((s, i) => {
    check(
      `services[${i}].${s.serviceSlug} (in=${s.inCostDescription || "—"} / out=${s.outCostDescription || "—"})`,
      s.patternP8.source_excerpt,
      s.patternP8.source_excerpt_verified,
      s.patternP8.source_section_verified,
    );
  });

  console.log("\n--- Other Covered: " + result.otherCoveredServices.length + " ---");
  result.otherCoveredServices.forEach((s, i) => {
    check(
      `otherCovered[${i}].${s.serviceSlug}`,
      s.patternP8.source_excerpt,
      s.patternP8.source_excerpt_verified,
      s.patternP8.source_section_verified,
    );
  });

  console.log("\n--- Excluded Services: " + result.excludedServices.length + " entries ---");
  if (result.excludedServicesPatternP8) {
    check(
      "excludedServices",
      result.excludedServicesPatternP8.source_excerpt,
      result.excludedServicesPatternP8.source_excerpt_verified,
      result.excludedServicesPatternP8.source_section_verified,
    );
  }

  console.log("\n--- Appeals Contacts: " + result.appealsContacts.length + " ---");
  result.appealsContacts.forEach((c, i) => {
    check(
      `appealsContacts[${i}] (city=${c.city || "—"} phone=${c.phone || "—"})`,
      c.patternP8.source_excerpt,
      c.patternP8.source_excerpt_verified,
      c.patternP8.source_section_verified,
    );
  });

  console.log("\n--- Cost: $" + result.costUsd.toFixed(4) + " ---");
  console.log("--- Warnings: " + result.parseWarnings.length + " ---");
  for (const w of result.parseWarnings.slice(0, 30)) console.log("  " + w);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
