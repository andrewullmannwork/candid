/**
 * Verify cold-start seeding outcome via direct DB queries.
 *
 * Usage:
 *   SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> \
 *     npx tsx scripts/admin-cold-start/verify.ts [manifest.json]
 *
 * For each successful upload (from upload-log.jsonl), checks:
 *   - documents row exists, status='processed'
 *   - insurance_plans row linked to a canonical_plan_id (Pattern 2 match landed)
 *   - canonical_plan_services row count for that canonical > 0
 *   - canonical_promotion_events rows with event_type='admin_override' exist
 *
 * Emits a markdown report at verify-report.md.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import type { ManifestEntry, UploadOutcome } from "./types";

config({ path: ".env.local" });

const SCRIPT_DIR = resolve(__dirname);
const UPLOAD_LOG_PATH = join(SCRIPT_DIR, "upload-log.jsonl");
const REPORT_PATH = join(SCRIPT_DIR, "verify-report.md");

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function readUploadLog(): Map<string, UploadOutcome> {
  const lines = existsSync(UPLOAD_LOG_PATH)
    ? readFileSync(UPLOAD_LOG_PATH, "utf-8").trim().split("\n").filter(Boolean)
    : [];
  const map = new Map<string, UploadOutcome>();
  for (const line of lines) {
    const o = JSON.parse(line) as UploadOutcome;
    map.set(o.seed_id, o);
  }
  return map;
}

interface VerifyRow {
  entry: ManifestEntry;
  documentStatus?: string;
  canonicalPlanId?: string;
  canonicalServicesCount: number;
  promotionEventCount: number;
  promotionEventTypes: string[];
  pass: boolean;
  notes: string[];
}

async function verifyOne(entry: ManifestEntry, upload: UploadOutcome | undefined): Promise<VerifyRow> {
  const row: VerifyRow = { entry, canonicalServicesCount: 0, promotionEventCount: 0, promotionEventTypes: [], pass: false, notes: [] };
  if (!upload || upload.status !== "ok" || !upload.document_id) {
    row.notes.push(`no successful upload (status=${upload?.status ?? "missing"})`);
    return row;
  }
  // 1. documents row
  const { data: doc } = await supabase.from("documents").select("id, status").eq("id", upload.document_id).maybeSingle();
  row.documentStatus = doc?.status;
  if (doc?.status !== "processed") { row.notes.push(`documents.status=${doc?.status ?? "missing"}`); return row; }

  // 2. insurance_plans → canonical_plan_id
  const { data: plan } = await supabase.from("insurance_plans").select("canonical_plan_id").eq("source_document_id", upload.document_id).not("canonical_plan_id", "is", null).maybeSingle();
  if (!plan?.canonical_plan_id) { row.notes.push("no insurance_plans row with canonical_plan_id linked"); return row; }
  row.canonicalPlanId = plan.canonical_plan_id;

  // 3. canonical_plan_services count
  const { count: svcCount } = await supabase.from("canonical_plan_services").select("*", { count: "exact", head: true }).eq("canonical_plan_id", plan.canonical_plan_id);
  row.canonicalServicesCount = svcCount ?? 0;

  // 4. canonical_promotion_events with admin_override
  const { data: events, count: eventCount } = await supabase.from("canonical_promotion_events").select("event_type", { count: "exact" }).eq("canonical_plan_id", plan.canonical_plan_id);
  row.promotionEventCount = eventCount ?? 0;
  row.promotionEventTypes = [...new Set((events ?? []).map((e) => e.event_type as string))];

  const hasAdminOverride = row.promotionEventTypes.includes("admin_override");
  row.pass = row.canonicalServicesCount > 0 && hasAdminOverride;
  if (!hasAdminOverride) row.notes.push("no event_type=admin_override fired (admin-bypass may not have triggered)");
  if (row.canonicalServicesCount === 0) row.notes.push("canonical_plan_services not populated");
  return row;
}

function renderReport(rows: VerifyRow[]): string {
  const passCount = rows.filter((r) => r.pass).length;
  const failCount = rows.length - passCount;
  const lines: string[] = [];
  lines.push(`# Admin Cold-Start Verification Report`);
  lines.push("");
  lines.push(`**Generated**: ${new Date().toISOString()}`);
  lines.push(`**Outcome**: ${passCount}/${rows.length} canonicals seeded successfully (${failCount} failures).`);
  lines.push("");
  lines.push(`| seed_id | state | insurer | plan_name | doc.status | canonical | services | events | event_types | pass | notes |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    lines.push(
      `| \`${r.entry.seed_id}\` | ${r.entry.state} | ${r.entry.insurer_name} | ${r.entry.plan_name} | ${r.documentStatus ?? "-"} | \`${r.canonicalPlanId?.slice(0, 8) ?? "-"}\` | ${r.canonicalServicesCount} | ${r.promotionEventCount} | ${r.promotionEventTypes.join(",") || "-"} | ${r.pass ? "✅" : "❌"} | ${r.notes.join("; ")} |`,
    );
  }
  lines.push("");
  lines.push(`---`);
  lines.push(`## Manual spot-check reminder`);
  lines.push(`After bulk seed, spot-check 5-10 canonical_plan_services rows against the source SBC PDFs to confirm Haiku didn't misread anything. Pattern 1 #14 audit invariant: admin attestation does not auto-validate data quality.`);
  return lines.join("\n");
}

async function main() {
  const manifestPath = process.argv[2] ?? join(SCRIPT_DIR, "manifest.json");
  if (!existsSync(manifestPath)) { console.error(`Manifest not found: ${manifestPath}`); process.exit(1); }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as ManifestEntry[];
  const uploads = readUploadLog();

  const rows: VerifyRow[] = [];
  for (const entry of manifest) {
    process.stdout.write(`[verify] ${entry.seed_id} ... `);
    const row = await verifyOne(entry, uploads.get(entry.seed_id));
    rows.push(row);
    console.log(row.pass ? `✅ services=${row.canonicalServicesCount} events=${row.promotionEventCount}` : `❌ ${row.notes.join("; ")}`);
  }
  const report = renderReport(rows);
  writeFileSync(REPORT_PATH, report);
  const pass = rows.filter((r) => r.pass).length;
  console.log(`\n[verify] done. ${pass}/${rows.length} passed. Report: ${REPORT_PATH}`);
  if (pass < rows.length) process.exit(2);
}

main().catch((err) => {
  console.error("[verify] fatal:", err);
  process.exit(1);
});
