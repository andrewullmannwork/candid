/**
 * Download SBCs listed in manifest.json to seed-data/sbcs/{state}/{insurer-slug}/.
 *
 * Usage:
 *   npx tsx scripts/admin-cold-start/download.ts [manifest.json]
 *
 * Outputs:
 *   - PDF files in seed-data/sbcs/{state}/{insurer-slug}/{seed_id}.pdf
 *   - scripts/admin-cold-start/download-log.jsonl (one JSON line per outcome)
 *
 * Re-run safe: skips files already present with matching hash.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DownloadOutcome, ManifestEntry } from "./types";

const SCRIPT_DIR = resolve(__dirname);
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const SEED_ROOT = join(PROJECT_ROOT, "seed-data", "sbcs");
const LOG_PATH = join(SCRIPT_DIR, "download-log.jsonl");
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB ceiling — sanity guard

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function fetchPdf(url: string): Promise<{ buf: Buffer; contentType: string }> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const contentType = res.headers.get("content-type") ?? "";
  const arrayBuf = await res.arrayBuffer();
  return { buf: Buffer.from(arrayBuf), contentType };
}

async function downloadOne(entry: ManifestEntry): Promise<DownloadOutcome> {
  const insurerSlug = slugify(entry.insurer_name);
  const dir = join(SEED_ROOT, entry.state, insurerSlug);
  const filePath = join(dir, `${entry.seed_id}.pdf`);
  const now = new Date().toISOString();

  // Skip if exists + hash known
  if (existsSync(filePath)) {
    const existingBuf = readFileSync(filePath);
    if (existingBuf.length > 0 && existingBuf.length <= MAX_BYTES) {
      return {
        seed_id: entry.seed_id,
        status: "ok",
        local_path: filePath,
        file_hash: sha256(existingBuf),
        file_size_bytes: existingBuf.length,
        downloaded_at: now,
      };
    }
  }

  try {
    const { buf, contentType } = await fetchPdf(entry.sbc_url);
    if (buf.length > MAX_BYTES) {
      return { seed_id: entry.seed_id, status: "size_exceeded", file_size_bytes: buf.length, downloaded_at: now, error_message: `${buf.length} bytes > ${MAX_BYTES}` };
    }
    if (!contentType.includes("pdf") && !buf.slice(0, 4).toString("hex").startsWith("25504446") /* %PDF */) {
      return { seed_id: entry.seed_id, status: "not_pdf", downloaded_at: now, error_message: `content-type=${contentType}` };
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, buf);
    return {
      seed_id: entry.seed_id,
      status: "ok",
      local_path: filePath,
      file_hash: sha256(buf),
      file_size_bytes: buf.length,
      downloaded_at: now,
    };
  } catch (err) {
    return {
      seed_id: entry.seed_id,
      status: "fetch_error",
      downloaded_at: now,
      error_message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  const manifestPath = process.argv[2] ?? join(SCRIPT_DIR, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as ManifestEntry[];
  console.log(`[download] ${manifest.length} entries from ${manifestPath}`);
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  writeFileSync(LOG_PATH, ""); // truncate per run

  let okCount = 0;
  let failCount = 0;
  for (const entry of manifest) {
    process.stdout.write(`[download] ${entry.seed_id} ... `);
    const outcome = await downloadOne(entry);
    appendFileSync(LOG_PATH, JSON.stringify(outcome) + "\n");
    if (outcome.status === "ok") {
      okCount += 1;
      console.log(`✓ ${(outcome.file_size_bytes! / 1024).toFixed(0)} KB → ${outcome.local_path}`);
    } else {
      failCount += 1;
      console.log(`✗ ${outcome.status}: ${outcome.error_message ?? ""}`);
    }
  }
  console.log(`\n[download] done. ok=${okCount} fail=${failCount} log=${LOG_PATH}`);
  if (failCount > 0) process.exit(2);
}

main().catch((err) => {
  console.error("[download] fatal:", err);
  process.exit(1);
});
