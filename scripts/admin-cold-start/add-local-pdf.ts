/**
 * Register an already-local PDF for admin seeding — skips the download step.
 *
 * Useful for the smoke test: re-seed Andrew's existing bs-bronze-60-ppo-clean-sbc.pdf
 * (file_hash e8a5540d557b...) without re-fetching it from CoveredCA / Blue Shield.
 *
 * Appends a manifest entry + download-log entry pointing at the local file.
 *
 * Usage:
 *   npx tsx scripts/admin-cold-start/add-local-pdf.ts <seed_id> <state> <insurer> <plan_name> <plan_year> <local_path>
 *
 * Example:
 *   npx tsx scripts/admin-cold-start/add-local-pdf.ts \
 *     ca-blueshield-bronze-60-ppo-2026 CA "Blue Shield of CA" "Bronze 60 PPO" 2026 \
 *     ~/Downloads/bs-bronze-60-ppo-clean-sbc.pdf
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DownloadOutcome, ManifestEntry } from "./types";

const SCRIPT_DIR = resolve(__dirname);
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const SEED_ROOT = join(PROJECT_ROOT, "seed-data", "sbcs");
const MANIFEST_PATH = join(SCRIPT_DIR, "manifest.json");
const DOWNLOAD_LOG_PATH = join(SCRIPT_DIR, "download-log.jsonl");

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function main() {
  const [seedId, state, insurer, planName, planYearStr, localPath] = process.argv.slice(2);
  if (!seedId || !state || !insurer || !planName || !planYearStr || !localPath) {
    console.error("Usage: npx tsx add-local-pdf.ts <seed_id> <state> <insurer> <plan_name> <plan_year> <local_path>");
    process.exit(1);
  }
  const planYear = parseInt(planYearStr, 10);
  const resolvedSource = resolve(localPath.replace(/^~/, process.env.HOME ?? ""));
  if (!existsSync(resolvedSource)) {
    console.error(`Source file not found: ${resolvedSource}`);
    process.exit(1);
  }

  // Copy to seed-data/sbcs/{state}/{insurer-slug}/{seed_id}.pdf
  const insurerSlug = slugify(insurer);
  const destDir = join(SEED_ROOT, state, insurerSlug);
  const destPath = join(destDir, `${seedId}.pdf`);
  mkdirSync(destDir, { recursive: true });
  copyFileSync(resolvedSource, destPath);
  const buf = readFileSync(destPath);
  const fileHash = sha256(buf);
  const stat = statSync(destPath);

  // Append to manifest.json (create if missing)
  const existing: ManifestEntry[] = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) : [];
  if (existing.some((e) => e.seed_id === seedId)) {
    console.warn(`[add-local-pdf] manifest already has seed_id=${seedId}; keeping existing entry.`);
  } else {
    existing.push({
      seed_id: seedId,
      state,
      source: "insurer_direct",
      insurer_name: insurer,
      plan_name: planName,
      plan_year: planYear,
      sbc_url: `local://${destPath}`,
      notes: `Imported from ${resolvedSource} via add-local-pdf.ts (skips download.ts step).`,
    });
    writeFileSync(MANIFEST_PATH, JSON.stringify(existing, null, 2));
  }

  // Append to download-log.jsonl
  mkdirSync(dirname(DOWNLOAD_LOG_PATH), { recursive: true });
  const outcome: DownloadOutcome = {
    seed_id: seedId,
    status: "ok",
    local_path: destPath,
    file_hash: fileHash,
    file_size_bytes: stat.size,
    downloaded_at: new Date().toISOString(),
  };
  appendFileSync(DOWNLOAD_LOG_PATH, JSON.stringify(outcome) + "\n");

  console.log(`[add-local-pdf] ✓ ${seedId}`);
  console.log(`  copied: ${resolvedSource} → ${destPath}`);
  console.log(`  hash:   ${fileHash}`);
  console.log(`  size:   ${(stat.size / 1024).toFixed(0)} KB`);
  console.log(`\nNext: npx tsx scripts/admin-cold-start/seed-via-service-role.ts`);
}

main();
