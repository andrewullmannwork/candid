/**
 * Service-role bypass — admin-seed PDFs without going through Firebase auth.
 *
 * Replaces upload-as-admin.ts (which required a Firebase ID token that's hard
 * to extract from Andrew's browser). This script uses SUPABASE_SERVICE_ROLE_KEY
 * to act as admin directly, bypassing HTTP / Firebase / Turnstile / consent.
 *
 * Pre-req: download.ts must have run first (reads download-log.jsonl).
 *
 * Usage:
 *   ADMIN_USER_ID=<andrew-uuid> \
 *   NEXT_PUBLIC_SUPABASE_URL=<dev-or-prod-url> \
 *   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
 *   BASE_URL=http://localhost:3000 \
 *     npx tsx scripts/admin-cold-start/seed-via-service-role.ts [manifest.json]
 *
 * Per-PDF sequence:
 *   1. Read file + compute SHA-256
 *   2. Upload to Supabase storage at <admin_user_id>/<documentId>.pdf
 *   3. INSERT documents row (status='uploaded')
 *   4. Call quickClassify (imports candid module directly — no HTTP)
 *   5. UPDATE documents with classification results
 *   6. Apply effective doc-type override via resolveEffectiveDocType helper
 *   7. enqueueChunk → chunk processor takes over
 *   8. Poll documents.status until 'processed' (or 'error' / timeout)
 *   9. Record outcome to upload-log.jsonl
 *
 * Sequential to avoid Haiku rate-limit pressure.
 *
 * NOTE: requires consent_event row for admin user. Pre-flight check creates
 * one if missing (admin can self-grant; pattern 1 #14 audit clear).
 */

import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { quickClassify } from "@/lib/classifier/quick-classify";
import { resolveEffectiveDocType } from "@/lib/documents/effective-doc-type";
import { loadDocTypeOverrideConfig } from "@/lib/config/doc-type-override-config";
import { enqueueChunk } from "@/lib/queue/qstash";
import type { DownloadOutcome, ManifestEntry, UploadOutcome } from "./types";

loadEnv({ path: resolve(__dirname, "../../.env.local") });

const SCRIPT_DIR = resolve(__dirname);
const LOG_PATH = join(SCRIPT_DIR, "upload-log.jsonl");
const DOWNLOAD_LOG_PATH = join(SCRIPT_DIR, "download-log.jsonl");

const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

if (!ADMIN_USER_ID || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Required env: ADMIN_USER_ID (UUID from users table), NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
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

async function ensureAdminConsent(): Promise<string> {
  const { data: existing } = await supabase
    .from("consent_events")
    .select("id")
    .eq("user_id", ADMIN_USER_ID!)
    .eq("consent_type", "health_data_upload")
    .eq("granted", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  // Self-grant admin consent — pattern 1 #14 audit clear (consent_events row
  // records admin user_id; future audit can filter by is_admin upload context).
  const { data: inserted, error } = await supabase
    .from("consent_events")
    .insert({ user_id: ADMIN_USER_ID, consent_type: "health_data_upload", granted: true })
    .select("id")
    .single();
  if (error || !inserted?.id) throw new Error(`failed to create admin consent: ${error?.message}`);
  console.log(`[seed] created admin consent row: ${inserted.id}`);
  return inserted.id as string;
}

async function seedOne(entry: ManifestEntry, localPath: string, consentEventId: string): Promise<UploadOutcome> {
  const now = new Date().toISOString();
  const buf = readFileSync(localPath);
  const fileHash = sha256(buf);
  const fileName = `${entry.seed_id}.pdf`;
  const ext = extname(localPath).slice(1) || "pdf";
  const documentId = randomUUID();
  const storagePath = `${ADMIN_USER_ID}/${documentId}.${ext}`;

  // 1. Storage upload (service role)
  const { error: uploadError } = await supabase.storage.from("documents").upload(storagePath, buf, { contentType: "application/pdf", upsert: false });
  if (uploadError) return { seed_id: entry.seed_id, status: "upload_error", uploaded_at: now, error_message: `storage: ${uploadError.message}` };

  // 2. INSERT documents row — initial doc_type guess from manifest source ("sbc" for plan docs)
  const initialDocType = "sbc"; // admin cold-start seeds plan documents
  const { error: insertError } = await supabase.from("documents").insert({
    id: documentId,
    user_id: ADMIN_USER_ID,
    storage_path: storagePath,
    file_name: fileName,
    file_size: buf.length,
    doc_type: initialDocType,
    consent_event_id: consentEventId,
    status: "uploaded",
    file_hash: fileHash,
  });
  if (insertError) return { seed_id: entry.seed_id, status: "upload_error", document_id: documentId, uploaded_at: now, error_message: `insert: ${insertError.message}` };

  // 3. Quick-classify (imports candid module directly — bypass HTTP)
  let classifiedType: string | undefined;
  let pageCount = 0;
  try {
    const classification = await quickClassify(buf, "application/pdf");
    classifiedType = classification.classifiedType;
    pageCount = classification.pageCount;
    await supabase.from("documents").update({
      classified_type: classification.classifiedType,
      classification_confidence: classification.confidence,
      type_mismatch: classification.classifiedType !== initialDocType,
      processing_total_pages: classification.pageCount,
    }).eq("id", documentId);

    // 4. Apply effective doc_type resolver
    const overrideConfig = await loadDocTypeOverrideConfig(supabase);
    const resolution = resolveEffectiveDocType(
      initialDocType as "eob" | "itemized_bill" | "sbc" | "plan_document",
      classification.classifiedType,
      classification.confidence,
      classification.pageCount,
      overrideConfig,
    );
    if (resolution.effectiveDocType !== initialDocType) {
      await supabase.from("documents").update({ doc_type: resolution.effectiveDocType }).eq("id", documentId);
    }
  } catch (err) {
    console.warn(`[seed] ${entry.seed_id} quickClassify error (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. Enqueue chunk processing
  await enqueueChunk(documentId, BASE_URL);

  // 6. Poll until terminal status
  const startedAt = Date.now();
  let lastStatus = "uploaded";
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const { data: doc } = await supabase.from("documents").select("status, processing_error, processing_step").eq("id", documentId).maybeSingle();
    if (!doc) continue;
    lastStatus = doc.status as string;
    if (lastStatus === "processed") {
      // Look up canonical_plan_id for outcome reporting
      const { data: plan } = await supabase.from("insurance_plans").select("canonical_plan_id").eq("source_document_id", documentId).not("canonical_plan_id", "is", null).maybeSingle();
      return {
        seed_id: entry.seed_id,
        status: "ok",
        document_id: documentId,
        canonical_plan_id: plan?.canonical_plan_id as string | undefined,
        uploaded_at: now,
        parse_completed_at: new Date().toISOString(),
      };
    }
    if (lastStatus === "error" || lastStatus === "rejected") {
      return { seed_id: entry.seed_id, status: "parse_error", document_id: documentId, uploaded_at: now, error_message: (doc.processing_error as string) ?? `final status=${lastStatus}` };
    }
  }
  return { seed_id: entry.seed_id, status: "parse_timeout", document_id: documentId, uploaded_at: now, error_message: `>${POLL_TIMEOUT_MS / 1000}s without terminal status (last=${lastStatus}); pageCount=${pageCount} classified=${classifiedType ?? "n/a"}` };
}

async function main() {
  const manifestPath = process.argv[2] ?? join(SCRIPT_DIR, "manifest.json");
  if (!existsSync(manifestPath)) { console.error(`Manifest not found: ${manifestPath}`); process.exit(1); }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as ManifestEntry[];
  const downloads = readDownloadLog();

  // Pre-flight: ensure admin consent row exists
  const consentEventId = await ensureAdminConsent();

  writeFileSync(LOG_PATH, "");
  let okCount = 0;
  let failCount = 0;
  for (const entry of manifest) {
    const dl = downloads.get(entry.seed_id);
    if (!dl || dl.status !== "ok" || !dl.local_path) {
      const outcome: UploadOutcome = { seed_id: entry.seed_id, status: "upload_error", uploaded_at: new Date().toISOString(), error_message: "no successful download; run download.ts first" };
      appendFileSync(LOG_PATH, JSON.stringify(outcome) + "\n");
      failCount += 1;
      console.log(`[seed] ${entry.seed_id} ✗ no-download`);
      continue;
    }
    process.stdout.write(`[seed] ${entry.seed_id} ... `);
    const outcome = await seedOne(entry, dl.local_path, consentEventId);
    appendFileSync(LOG_PATH, JSON.stringify(outcome) + "\n");
    if (outcome.status === "ok") {
      okCount += 1;
      console.log(`✓ doc=${outcome.document_id?.slice(0, 8)} canonical=${outcome.canonical_plan_id?.slice(0, 8) ?? "-"}`);
    } else {
      failCount += 1;
      console.log(`✗ ${outcome.status}: ${outcome.error_message ?? ""}`);
    }
  }
  console.log(`\n[seed] done. ok=${okCount} fail=${failCount} log=${LOG_PATH}`);
  if (failCount > 0) process.exit(2);
}

main().catch((err) => {
  console.error("[seed] fatal:", err);
  process.exit(1);
});
