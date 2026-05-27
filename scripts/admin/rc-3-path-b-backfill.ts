/**
 * RC-3 Path B PR #2 — typed-column + JSONB-coinsurance backfill (S135 backend)
 *
 * Syncs historical canonical_plans + canonical_plan_services typed columns
 * to their field_provenance.<field>.value JSONB entries (where confidence
 * >= 0.9). Also normalizes JSONB-side coinsurance from mixed encoding to
 * decimal [0, 1] for one-pass cleanup of write-side residue.
 *
 * Per plans/rc-3-path-b-pr-2-backfill-scope.md.
 *
 * MODES
 *
 *   default              — DRY-RUN. Print all UPDATEs that would fire +
 *                          summary counts. Does NOT execute. Idempotent.
 *   --apply              — Refuses; requires the paranoia flag too.
 *   --apply              — Execute. Chunks at 1000 rows. Audits to
 *   --i-understand-this-modifies-prod
 *                          path_b_backfill_audit table per row updated.
 *   --resume <uuid>      — In --apply mode, skip canonical rows up to <uuid>
 *                          (recovery from partial run; processes the next
 *                          row id-greater-than <uuid>).
 *
 * Run examples:
 *   set -a && source .env.local && set +a
 *   npx tsx scripts/admin/rc-3-path-b-backfill.ts                                # dry-run
 *   npx tsx scripts/admin/rc-3-path-b-backfill.ts --apply --i-understand-this-modifies-prod
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { normalizeCoinsuranceForStorage } from "../../src/lib/billing/coinsurance";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env.");
  process.exit(1);
}

// ── CLI flag parsing ──
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const PARANOIA_FLAG = args.includes("--i-understand-this-modifies-prod");
const resumeIdx = args.indexOf("--resume");
const RESUME_FROM: string | null = resumeIdx >= 0 && args[resumeIdx + 1] ? args[resumeIdx + 1] : null;

if (APPLY && !PARANOIA_FLAG) {
  console.error("❌ --apply requires --i-understand-this-modifies-prod");
  process.exit(1);
}

const MODE = APPLY ? "APPLY (PROD writes enabled)" : "DRY-RUN (read-only)";
console.log(`\nRC-3 Path B PR #2 backfill — ${MODE}`);
if (RESUME_FROM) console.log(`  --resume canonical_plan_id > ${RESUME_FROM}`);
console.log("");

const sb: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// ── Field maps (mirror PR #1 / mig 129) ──

interface FieldEntry {
  jsonKey: string;
  typedCol: string;
  jsonbType: "number" | "string" | "boolean";
}

const CP_FIELDS: FieldEntry[] = [
  { jsonKey: "in_deductible_individual", typedCol: "deductible_individual", jsonbType: "number" },
  { jsonKey: "in_deductible_family", typedCol: "deductible_family", jsonbType: "number" },
  { jsonKey: "in_oop_max_individual", typedCol: "oop_max_individual", jsonbType: "number" },
  { jsonKey: "in_oop_max_family", typedCol: "oop_max_family", jsonbType: "number" },
  { jsonKey: "plan_name", typedCol: "plan_name", jsonbType: "string" },
  { jsonKey: "plan_year", typedCol: "plan_year", jsonbType: "number" },
  { jsonKey: "plan_type", typedCol: "plan_type", jsonbType: "string" },
  { jsonKey: "metal_level", typedCol: "metal_level", jsonbType: "string" },
];

const CPS_FIELDS: FieldEntry[] = [
  { jsonKey: "copay", typedCol: "copay", jsonbType: "number" },
  { jsonKey: "coinsurance", typedCol: "coinsurance", jsonbType: "number" },
  { jsonKey: "deductible_applies", typedCol: "deductible_applies", jsonbType: "boolean" },
  { jsonKey: "is_covered", typedCol: "is_covered", jsonbType: "boolean" },
  { jsonKey: "requires_prior_auth", typedCol: "requires_prior_auth", jsonbType: "boolean" },
];

// ── Audit table for spot-check + rollback ──
const AUDIT_TABLE = "path_b_backfill_audit";

async function ensureAuditTable() {
  if (!APPLY) return;
  // Create via raw SQL through an admin RPC pattern — but easier: assume table is created externally
  // before running backfill. Print the CREATE TABLE statement for Andrew to paste into Studio.
  const createSql = `
CREATE TABLE IF NOT EXISTS path_b_backfill_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table TEXT NOT NULL CHECK (source_table IN ('canonical_plans', 'canonical_plan_services')),
  source_row_id UUID NOT NULL,
  field_name TEXT NOT NULL,
  old_typed_value TEXT,
  new_typed_value TEXT,
  old_json_value JSONB,
  new_json_value JSONB,
  fired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_path_b_backfill_audit_source ON path_b_backfill_audit (source_table, source_row_id);
`;

  // Probe whether table exists
  const { error } = await sb.from(AUDIT_TABLE).select("id").limit(1);
  if (error && error.code === "PGRST205") {
    // PGRST205 = relation does not exist
    console.error("\n❌ Audit table path_b_backfill_audit does not exist.");
    console.error("   Apply this SQL via Supabase Studio before re-running with --apply:\n");
    console.error(createSql);
    process.exit(1);
  }
  if (error) {
    console.error(`audit table probe error: ${error.message}`);
    process.exit(1);
  }
  console.log(`  ✓ Audit table path_b_backfill_audit exists\n`);
}

// ── Stats accumulator ──
interface Stats {
  rowsScanned: number;
  rowsWithProvenance: number;
  fieldsConsidered: number;
  fieldsBelowConfidence: number;
  fieldsAlreadyInSync: number;
  fieldsTypeMismatch: number;
  fieldsCoinsuranceJsonNormalized: number;
  fieldsUpdated: number;
}

function newStats(): Stats {
  return {
    rowsScanned: 0,
    rowsWithProvenance: 0,
    fieldsConsidered: 0,
    fieldsBelowConfidence: 0,
    fieldsAlreadyInSync: 0,
    fieldsTypeMismatch: 0,
    fieldsCoinsuranceJsonNormalized: 0,
    fieldsUpdated: 0,
  };
}

function printStats(label: string, s: Stats) {
  console.log(`\n${label}:`);
  console.log(`  rows scanned: ${s.rowsScanned}`);
  console.log(`  rows with non-empty field_provenance: ${s.rowsWithProvenance}`);
  console.log(`  fields considered (>=0.9 confidence): ${s.fieldsConsidered}`);
  console.log(`  fields skipped (below 0.9 confidence): ${s.fieldsBelowConfidence}`);
  console.log(`  fields already in sync (idempotent no-op): ${s.fieldsAlreadyInSync}`);
  console.log(`  fields skipped (JSONB type mismatch): ${s.fieldsTypeMismatch}`);
  console.log(`  coinsurance JSONB normalized (integer-percent -> decimal): ${s.fieldsCoinsuranceJsonNormalized}`);
  console.log(`  fields ${APPLY ? "updated" : "would-update"}: ${s.fieldsUpdated}`);
}

// ── Helper: coerce JSONB to typed value ──
function coerceForTypedCol(jsonVal: unknown, jsonbType: string): unknown {
  if (jsonVal === null || jsonVal === undefined) return null;
  if (jsonbType === "number") return typeof jsonVal === "number" ? jsonVal : null;
  if (jsonbType === "string") return typeof jsonVal === "string" ? jsonVal : null;
  if (jsonbType === "boolean") return typeof jsonVal === "boolean" ? jsonVal : null;
  return null;
}

// ── Audit insert ──
async function recordAudit(
  sourceTable: "canonical_plans" | "canonical_plan_services",
  sourceRowId: string,
  fieldName: string,
  oldTypedValue: unknown,
  newTypedValue: unknown,
  oldJsonValue: unknown,
  newJsonValue: unknown,
) {
  if (!APPLY) return;
  const { error } = await sb.from(AUDIT_TABLE).insert({
    source_table: sourceTable,
    source_row_id: sourceRowId,
    field_name: fieldName,
    old_typed_value: oldTypedValue === null || oldTypedValue === undefined ? null : String(oldTypedValue),
    new_typed_value: newTypedValue === null || newTypedValue === undefined ? null : String(newTypedValue),
    old_json_value: oldJsonValue,
    new_json_value: newJsonValue,
  });
  if (error) {
    console.error(`  audit insert failed for ${sourceTable}/${sourceRowId}/${fieldName}: ${error.message}`);
  }
}

// ── canonical_plans backfill ──
async function backfillCanonicalPlans(stats: Stats) {
  console.log("─".repeat(70));
  console.log("§1 — canonical_plans backfill");
  console.log("─".repeat(70));

  const PAGE_SIZE = 500;
  let lastId: string | null = RESUME_FROM;

  while (true) {
    let q = sb
      .from("canonical_plans")
      .select(
        "id, deductible_individual, deductible_family, oop_max_individual, oop_max_family, plan_name, plan_year, plan_type, metal_level, field_provenance",
      )
      .neq("field_provenance", "{}")
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (lastId) q = q.gt("id", lastId);
    const { data, error } = await q;
    if (error) {
      console.error(`canonical_plans fetch error: ${error.message}`);
      return;
    }
    const rows = data || [];
    if (rows.length === 0) break;

    for (const row of rows as Array<Record<string, unknown>>) {
      stats.rowsScanned += 1;
      const fp = (row.field_provenance as Record<string, { value?: unknown; confidence?: number }> | null) || {};
      if (Object.keys(fp).length === 0) continue;
      stats.rowsWithProvenance += 1;

      for (const f of CP_FIELDS) {
        const entry = fp[f.jsonKey];
        if (!entry || typeof entry.confidence !== "number" || entry.confidence < 0.9) {
          if (entry) stats.fieldsBelowConfidence += 1;
          continue;
        }
        stats.fieldsConsidered += 1;
        const jsonVal = entry.value;
        if (jsonVal === null || jsonVal === undefined) continue;

        const typeofJson = jsonVal === null ? "null" : typeof jsonVal;
        if (typeofJson !== f.jsonbType) {
          stats.fieldsTypeMismatch += 1;
          if (!APPLY) {
            console.log(`  [dry] SKIP ${row.id}/${f.typedCol}: jsonb_typeof=${typeofJson} expected=${f.jsonbType}`);
          }
          continue;
        }

        const coerced = coerceForTypedCol(jsonVal, f.jsonbType);
        const typedVal = row[f.typedCol];
        if (typedVal !== null && typedVal !== undefined && String(typedVal) === String(coerced)) {
          stats.fieldsAlreadyInSync += 1;
          continue;
        }

        stats.fieldsUpdated += 1;
        if (APPLY) {
          await recordAudit("canonical_plans", row.id as string, f.typedCol, typedVal, coerced, jsonVal, jsonVal);
          const { error: updErr } = await sb
            .from("canonical_plans")
            .update({ [f.typedCol]: coerced })
            .eq("id", row.id);
          if (updErr) {
            console.error(`  UPDATE error ${row.id}/${f.typedCol}: ${updErr.message}`);
          }
        } else {
          console.log(`  [dry] UPDATE canonical_plans ${(row.id as string).slice(0, 8)}.${f.typedCol}: ${typedVal} -> ${coerced}`);
        }
      }
      lastId = row.id as string;
    }

    if (stats.rowsScanned % 1000 === 0) {
      console.log(`  ... ${stats.rowsScanned} rows scanned, ${stats.fieldsUpdated} updates ${APPLY ? "applied" : "queued"}`);
    }
    if (rows.length < PAGE_SIZE) break;
  }
}

// ── canonical_plan_services backfill (includes coinsurance JSONB normalization) ──
async function backfillCanonicalPlanServices(stats: Stats) {
  console.log("\n" + "─".repeat(70));
  console.log("§2 — canonical_plan_services backfill (+ coinsurance JSONB normalize)");
  console.log("─".repeat(70));

  const PAGE_SIZE = 500;
  let lastId: string | null = null;

  while (true) {
    let q = sb
      .from("canonical_plan_services")
      .select("id, copay, coinsurance, deductible_applies, is_covered, requires_prior_auth, field_provenance, confidence")
      .gte("confidence", 0.9)
      .neq("field_provenance", "{}")
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (lastId) q = q.gt("id", lastId);
    const { data, error } = await q;
    if (error) {
      console.error(`canonical_plan_services fetch error: ${error.message}`);
      return;
    }
    const rows = data || [];
    if (rows.length === 0) break;

    for (const row of rows as Array<Record<string, unknown>>) {
      stats.rowsScanned += 1;
      const fp = (row.field_provenance as Record<string, { value?: unknown; confidence?: number }> | null) || {};
      if (Object.keys(fp).length === 0) continue;
      stats.rowsWithProvenance += 1;

      // Process all fields for this row in ONE pass so we can batch the UPDATE
      const updateSet: Record<string, unknown> = {};
      const jsonbPatches: Record<string, unknown> = {};

      for (const f of CPS_FIELDS) {
        const entry = fp[f.jsonKey];
        if (!entry || typeof entry.confidence !== "number" || entry.confidence < 0.9) {
          if (entry) stats.fieldsBelowConfidence += 1;
          continue;
        }
        stats.fieldsConsidered += 1;
        const jsonVal = entry.value;
        if (jsonVal === null || jsonVal === undefined) continue;

        const typeofJson = jsonVal === null ? "null" : typeof jsonVal;
        if (typeofJson !== f.jsonbType) {
          stats.fieldsTypeMismatch += 1;
          if (!APPLY) {
            console.log(`  [dry] SKIP ${row.id}/${f.typedCol}: jsonb_typeof=${typeofJson} expected=${f.jsonbType}`);
          }
          continue;
        }

        // Coinsurance: normalize JSONB-side if needed; also update typed col
        let jsonValForTyped: unknown = jsonVal;
        if (f.jsonKey === "coinsurance") {
          const normalized = normalizeCoinsuranceForStorage(jsonVal as number);
          if (normalized !== jsonVal && normalized !== null) {
            jsonbPatches.coinsurance = normalized;
            stats.fieldsCoinsuranceJsonNormalized += 1;
            jsonValForTyped = normalized;
          }
        }

        const coerced = coerceForTypedCol(jsonValForTyped, f.jsonbType);
        const typedVal = row[f.typedCol];
        if (typedVal !== null && typedVal !== undefined && String(typedVal) === String(coerced)) {
          stats.fieldsAlreadyInSync += 1;
          continue;
        }

        updateSet[f.typedCol] = coerced;
        stats.fieldsUpdated += 1;
      }

      // Apply JSONB coinsurance normalization (if any)
      if (Object.keys(jsonbPatches).length > 0) {
        const newFp = JSON.parse(JSON.stringify(fp)) as Record<string, { value?: unknown }>;
        for (const [k, v] of Object.entries(jsonbPatches)) {
          if (newFp[k]) newFp[k].value = v;
        }
        if (APPLY) {
          await recordAudit("canonical_plan_services", row.id as string, "coinsurance.json_normalize", null, null, fp.coinsurance?.value, jsonbPatches.coinsurance);
          const { error: jsonbErr } = await sb
            .from("canonical_plan_services")
            .update({ field_provenance: newFp })
            .eq("id", row.id);
          if (jsonbErr) console.error(`  JSONB patch error ${row.id}: ${jsonbErr.message}`);
        } else {
          console.log(`  [dry] PATCH canonical_plan_services ${(row.id as string).slice(0, 8)}.field_provenance.coinsurance.value: ${fp.coinsurance?.value} -> ${jsonbPatches.coinsurance}`);
        }
      }

      // Apply typed-col UPDATE
      if (Object.keys(updateSet).length > 0) {
        if (APPLY) {
          // Audit per-field before batch update
          for (const [col, newVal] of Object.entries(updateSet)) {
            const oldVal = row[col];
            const fpKey = CPS_FIELDS.find((x) => x.typedCol === col)?.jsonKey || col;
            const jsonValForAudit = fp[fpKey]?.value;
            await recordAudit("canonical_plan_services", row.id as string, col, oldVal, newVal, jsonValForAudit, jsonValForAudit);
          }
          const { error: updErr } = await sb
            .from("canonical_plan_services")
            .update(updateSet)
            .eq("id", row.id);
          if (updErr) console.error(`  UPDATE error ${row.id}: ${updErr.message}`);
        } else {
          for (const [col, newVal] of Object.entries(updateSet)) {
            const oldVal = row[col];
            console.log(`  [dry] UPDATE canonical_plan_services ${(row.id as string).slice(0, 8)}.${col}: ${oldVal} -> ${newVal}`);
          }
        }
      }

      lastId = row.id as string;
    }

    if (stats.rowsScanned % 5000 === 0) {
      console.log(`  ... ${stats.rowsScanned} cps rows scanned, ${stats.fieldsUpdated} field-updates ${APPLY ? "applied" : "queued"}`);
    }
    if (rows.length < PAGE_SIZE) break;
  }
}

async function main() {
  await ensureAuditTable();

  const cpStats = newStats();
  await backfillCanonicalPlans(cpStats);
  printStats("canonical_plans", cpStats);

  const cpsStats = newStats();
  await backfillCanonicalPlanServices(cpsStats);
  printStats("canonical_plan_services", cpsStats);

  console.log("\n" + "═".repeat(70));
  console.log(`Mode: ${MODE}`);
  console.log(`Total field-updates ${APPLY ? "APPLIED" : "WOULD-APPLY"}: ${cpStats.fieldsUpdated + cpsStats.fieldsUpdated}`);
  console.log(`Total JSONB coinsurance normalizations ${APPLY ? "APPLIED" : "WOULD-APPLY"}: ${cpStats.fieldsCoinsuranceJsonNormalized + cpsStats.fieldsCoinsuranceJsonNormalized}`);
  console.log(`Idempotent no-ops (already in sync): ${cpStats.fieldsAlreadyInSync + cpsStats.fieldsAlreadyInSync}`);
  if (!APPLY) {
    console.log("\nRun with --apply --i-understand-this-modifies-prod to execute.");
  }
}

void main();
