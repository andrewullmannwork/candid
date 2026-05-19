/**
 * Upload pre-downloaded SBCs as admin via /api/documents/upload.
 *
 * Pre-req: download.ts must have run first (reads download-log.jsonl).
 *
 * Usage:
 *   ADMIN_AUTH_TOKEN=<bearer> TARGET_URL=http://localhost:3000 \
 *     npx tsx scripts/admin-cold-start/upload-as-admin.ts [manifest.json]
 *
 * Per-upload sequence:
 *   1. POST {TARGET_URL}/api/documents/upload (multipart/form-data)
 *   2. Poll GET {TARGET_URL}/api/documents/status?id=<documentId> every 5s
 *   3. Wait until status='processed' OR status='error' OR 5-min timeout
 *   4. Record outcome to upload-log.jsonl
 *
 * Sequential (not parallel) to avoid Haiku rate-limit pressure.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import type { DownloadOutcome, ManifestEntry, UploadOutcome } from "./types";

const SCRIPT_DIR = resolve(__dirname);
const LOG_PATH = join(SCRIPT_DIR, "upload-log.jsonl");
const DOWNLOAD_LOG_PATH = join(SCRIPT_DIR, "download-log.jsonl");

const ADMIN_AUTH_TOKEN = process.env.ADMIN_AUTH_TOKEN;
const TARGET_URL = (process.env.TARGET_URL ?? "http://localhost:3000").replace(/\/$/, "");
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

if (!ADMIN_AUTH_TOKEN) {
  console.error("ADMIN_AUTH_TOKEN env var required (Supabase session bearer token for an is_admin user).");
  process.exit(1);
}

function readDownloadLog(): Map<string, DownloadOutcome> {
  const lines = existsSync(DOWNLOAD_LOG_PATH)
    ? readFileSync(DOWNLOAD_LOG_PATH, "utf-8").trim().split("\n").filter(Boolean)
    : [];
  const map = new Map<string, DownloadOutcome>();
  for (const line of lines) {
    const o = JSON.parse(line) as DownloadOutcome;
    map.set(o.seed_id, o);
  }
  return map;
}

async function uploadOne(entry: ManifestEntry, localPath: string): Promise<UploadOutcome> {
  const now = new Date().toISOString();
  const buf = readFileSync(localPath);
  const fileName = basename(localPath);
  const blob = new Blob([buf], { type: "application/pdf" });
  const formData = new FormData();
  formData.append("file", blob, fileName);
  // purpose defaults to 'primary'; do not pass 'comparison' (which would skip dedup)

  let documentId: string;
  try {
    const res = await fetch(`${TARGET_URL}/api/documents/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_AUTH_TOKEN}` },
      body: formData,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      return { seed_id: entry.seed_id, status: "upload_error", uploaded_at: now, error_message: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const json = await res.json();
    documentId = json.documentId;
    if (!documentId) {
      return { seed_id: entry.seed_id, status: "upload_error", uploaded_at: now, error_message: `no documentId in response: ${JSON.stringify(json).slice(0, 200)}` };
    }
  } catch (err) {
    return { seed_id: entry.seed_id, status: "upload_error", uploaded_at: now, error_message: err instanceof Error ? err.message : String(err) };
  }

  // Poll for completion
  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${TARGET_URL}/api/documents/status?id=${documentId}`, {
        headers: { Authorization: `Bearer ${ADMIN_AUTH_TOKEN}` },
      });
      if (!res.ok) continue;
      const status = await res.json();
      if (status.status === "processed") {
        return {
          seed_id: entry.seed_id,
          status: "ok",
          document_id: documentId,
          canonical_plan_id: status.linkedInsurancePlanId, // status route returns linked plan; canonical_plan_id derivable from plan
          uploaded_at: now,
          parse_completed_at: new Date().toISOString(),
        };
      }
      if (status.status === "error" || status.status === "rejected") {
        return {
          seed_id: entry.seed_id,
          status: "parse_error",
          document_id: documentId,
          uploaded_at: now,
          error_message: status.processingError ?? `final status=${status.status}`,
        };
      }
      // status === "uploaded" / "queued" / "processing" / "awaiting_user_confirmation" → continue polling
    } catch {
      // transient — keep polling
    }
  }
  return { seed_id: entry.seed_id, status: "parse_timeout", document_id: documentId, uploaded_at: now, error_message: `>${POLL_TIMEOUT_MS / 1000}s without terminal status` };
}

async function main() {
  const manifestPath = process.argv[2] ?? join(SCRIPT_DIR, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as ManifestEntry[];
  const downloads = readDownloadLog();

  writeFileSync(LOG_PATH, ""); // truncate per run
  let okCount = 0;
  let failCount = 0;
  for (const entry of manifest) {
    const dl = downloads.get(entry.seed_id);
    if (!dl || dl.status !== "ok" || !dl.local_path) {
      const outcome: UploadOutcome = {
        seed_id: entry.seed_id,
        status: "upload_error",
        uploaded_at: new Date().toISOString(),
        error_message: `no successful download for seed_id; run download.ts first`,
      };
      appendFileSync(LOG_PATH, JSON.stringify(outcome) + "\n");
      failCount += 1;
      console.log(`[upload] ${entry.seed_id} ✗ no-download`);
      continue;
    }
    process.stdout.write(`[upload] ${entry.seed_id} → ${TARGET_URL}... `);
    const outcome = await uploadOne(entry, dl.local_path);
    appendFileSync(LOG_PATH, JSON.stringify(outcome) + "\n");
    if (outcome.status === "ok") {
      okCount += 1;
      console.log(`✓ doc=${outcome.document_id?.slice(0, 8)} parse=ok`);
    } else {
      failCount += 1;
      console.log(`✗ ${outcome.status}: ${outcome.error_message ?? ""}`);
    }
  }
  console.log(`\n[upload] done. ok=${okCount} fail=${failCount} log=${LOG_PATH}`);
  if (failCount > 0) process.exit(2);
}

main().catch((err) => {
  console.error("[upload] fatal:", err);
  process.exit(1);
});
