/**
 * N2 — Canonical coinsurance value backfill (S244 — Group B cold-start §14 gate, data side).
 *
 * Sibling to scripts/corroboration-ps/value-key-backfill.ts, which corrects the USER tables only
 * (plan_covered_services + insurance_plans) and never touches canonical. S243's mig-187 probe found
 * ~3% of canonical_plan_services coinsurance provenance `.value`s still stored RAW (percent, e.g. 20)
 * while the typed column is the uniformly-decimal 0.2 → the percent/decimal SPLIT that silently breaks
 * coinsurance corroboration (the Pattern-1 evaluator reads field_provenance.<field>.value, NOT the
 * column). This script CORRECTS them so the cold-start seed is corroboration-ready before launch.
 *
 * §14 #3 contract enforced per row: in_coinsurance / out_coinsurance column == field_provenance.<f>.value
 * == normalizeCoinsuranceForStorage(raw) ∈ [0,1].
 *
 * Per coinsurance field (in_coinsurance, out_coinsurance) where a provenance entry + a non-null column exist:
 *   normCol = normalizeCoinsuranceForStorage(column)            // the §14 target decimal
 *   - OK              column decimal AND value === normCol                  → no-op
 *   - VALUE_FIX       column decimal; value raw/missing/≠normCol           → set value := normCol (field_provenance only)
 *   - COLUMN_CORRUPT  column itself raw (>1)  [§14 says this should be 0]  → set column := normCol AND value := normCol
 *
 * SELF-VALIDATING: after --apply it RE-SCANS read-only and asserts 0 VALUE_FIX + 0 COLUMN_CORRUPT remain
 * (exits nonzero + loud otherwise). Dry-run reports the buckets without writing (this is also the probe).
 *
 * DRY-RUN default (READ-ONLY). --apply writes. Idempotent. Aggregate output (coinsurance values are
 * numbers, not PII; any string is redacted). Service-role admin maintenance on canonical (Andrew-approved
 * N2 — the sanctioned non-user-facing canonical-write path, consistent with §14's validation-gate language;
 * Rule #4/#10 forbids USER-facing canonical writes, not admin/seed maintenance).
 *
 *   npx tsx scripts/corroboration-ps/canonical-coinsurance-value-backfill.ts          # dry-run (read-only)
 *   npx tsx scripts/corroboration-ps/canonical-coinsurance-value-backfill.ts --apply  # write
 */
import { config } from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";

// .env.local lives at the repo root; resolve whether run from a normal checkout or a git worktree.
const ENV_CANDIDATES = [
  resolve(__dirname, "../../.env.local"), // normal checkout: scripts/corroboration-ps → repo root
  resolve(__dirname, "../../../../../.env.local"), // worktree: .claude/worktrees/<wt>/scripts/corroboration-ps → main checkout root
];
const ENV_PATH = ENV_CANDIDATES.find(existsSync);
if (!ENV_PATH) {
  console.error("No .env.local found. Tried:\n  " + ENV_CANDIDATES.join("\n  "));
  process.exit(1);
}
config({ path: ENV_PATH, override: true });

import { createClient } from "@supabase/supabase-js";
import { normalizeCoinsuranceForStorage } from "../../src/lib/billing/coinsurance";

const APPLY = process.argv.includes("--apply");
const TABLE = "canonical_plan_services";
const COINS_FIELDS = ["in_coinsurance", "out_coinsurance"] as const;
const EPS = 1e-9;

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

type ProvEntry = Record<string, unknown>;
type Row = {
  id: string;
  in_coinsurance: number | string | null;
  out_coinsurance: number | string | null;
  field_provenance: Record<string, ProvEntry> | null;
};

interface Stat {
  rowsScanned: number;
  rowsWithProvenance: number;
  ok: number; // value==column==decimal
  valueFix: number; // value-only corrections (field_provenance write)
  columnCorrupt: number; // raw typed column (>1) — normalizes both column + value
  rowsUpdated: number;
  entriesSkippedNullCol: number; // provenance entry present but column null/non-finite
  samples: Array<{ id: string; field: string; kind: string; col: string; oldVal: string; newVal: string }>;
}

function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}
function redact(v: unknown): string {
  return typeof v === "string" ? `[str:${v.length}]` : JSON.stringify(v);
}
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

/** select * limit 1 → confirm the columns we read/write actually exist (probe discipline). */
async function verifyColumns(): Promise<void> {
  const { data, error } = await sb.from(TABLE).select("*").limit(1);
  if (error) {
    console.error(`${TABLE} column-verify query error:`, error.message);
    process.exit(1);
  }
  const sample = (data ?? [])[0];
  if (!sample) {
    console.error(`${TABLE} returned no rows — cannot verify columns / nothing to backfill.`);
    process.exit(1);
  }
  const need = ["id", "field_provenance", ...COINS_FIELDS];
  const missing = need.filter((k) => !(k in sample));
  if (missing.length) {
    console.error(`${TABLE} missing expected columns: ${missing.join(", ")} (found keys: ${Object.keys(sample).join(", ")})`);
    process.exit(1);
  }
  console.log(`✓ ${TABLE} columns verified: ${need.join(", ")}`);
}

async function processTable(doWrite: boolean): Promise<Stat> {
  const stat: Stat = {
    rowsScanned: 0, rowsWithProvenance: 0, ok: 0, valueFix: 0, columnCorrupt: 0,
    rowsUpdated: 0, entriesSkippedNullCol: 0, samples: [],
  };
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from(TABLE)
      .select("id, in_coinsurance, out_coinsurance, field_provenance")
      .not("field_provenance", "is", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      console.error(`${TABLE} scan query error:`, error.message);
      process.exit(1);
    }
    const rows = (data ?? []) as Row[];
    if (rows.length === 0) break;

    for (const row of rows) {
      stat.rowsScanned++;
      const prov = row.field_provenance;
      if (!prov || typeof prov !== "object") continue;
      stat.rowsWithProvenance++;

      const nextProv: Record<string, ProvEntry> = { ...prov };
      const colPatch: Record<string, number> = {};
      let rowChanged = false;

      for (const field of COINS_FIELDS) {
        const entry = prov[field];
        if (!entry || typeof entry !== "object") continue; // no provenance for this coinsurance field
        const colNum = toNum(row[field]);
        if (colNum === null) { stat.entriesSkippedNullCol++; continue; } // nothing stored to mirror
        const normCol = normalizeCoinsuranceForStorage(colNum);
        if (normCol === null) { stat.entriesSkippedNullCol++; continue; }

        const columnCorrupt = !approxEq(colNum, normCol); // typed column not already decimal (was >1)
        const valNum = toNum((entry as ProvEntry).value);
        const valueOk = valNum !== null && approxEq(valNum, normCol);

        if (!columnCorrupt && valueOk) { stat.ok++; continue; }

        // Needs a fix → value := normCol always; column := normCol only when the column itself is corrupt.
        nextProv[field] = { ...(entry as ProvEntry), value: normCol };
        rowChanged = true;
        const kind = columnCorrupt ? "COLUMN_CORRUPT" : "VALUE_FIX";
        if (columnCorrupt) { colPatch[field] = normCol; stat.columnCorrupt++; } else { stat.valueFix++; }
        if (stat.samples.length < 20) {
          stat.samples.push({
            id: row.id, field, kind,
            col: redact(row[field]),
            oldVal: redact((entry as ProvEntry).value),
            newVal: String(normCol),
          });
        }
      }

      if (rowChanged && doWrite) {
        const patch: Record<string, unknown> = { field_provenance: nextProv, ...colPatch };
        const { error: upErr } = await sb.from(TABLE).update(patch).eq("id", row.id);
        if (upErr) console.error(`  update ${TABLE} ${row.id} failed:`, upErr.message);
        else stat.rowsUpdated++;
      }
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return stat;
}

function report(label: string, s: Stat): void {
  const examined = s.ok + s.valueFix + s.columnCorrupt;
  const nonCompliant = s.valueFix + s.columnCorrupt;
  const pct = examined > 0 ? ((nonCompliant / examined) * 100).toFixed(2) : "0.00";
  console.log(`\n=== ${label} (${TABLE}) ===`);
  console.log(`  rows with field_provenance / scanned: ${s.rowsWithProvenance} / ${s.rowsScanned}`);
  console.log(`  coinsurance field-entries examined (non-null column): ${examined}`);
  console.log(`  OK (value == column == decimal): ${s.ok}`);
  console.log(`  VALUE_FIX (value raw/missing/≠col; column already decimal): ${s.valueFix}`);
  console.log(`  ${s.columnCorrupt > 0 ? "⚠ " : ""}COLUMN_CORRUPT (raw typed column >1; normalizes column+value): ${s.columnCorrupt}`);
  console.log(`  non-compliant: ${nonCompliant} / ${examined} (${pct}%)`);
  console.log(`  entries skipped (column null/non-finite): ${s.entriesSkippedNullCol}`);
  console.log(`  rows updated: ${APPLY ? s.rowsUpdated : "(dry-run — 0)"}`);
  for (const m of s.samples.slice(0, 12)) {
    console.log(`     ${m.kind} ${String(m.id).slice(0, 8)} ${m.field}: column=${m.col} value ${m.oldVal} → ${m.newVal}`);
  }
}

async function main(): Promise<void> {
  console.log(`MODE: ${APPLY ? "APPLY (writing canonical_plan_services)" : "DRY-RUN (read-only)"}`);
  await verifyColumns();

  const pass1 = await processTable(APPLY);
  report(APPLY ? "APPLY PASS" : "DRY-RUN", pass1);

  if (APPLY) {
    const verify = await processTable(false); // read-only re-scan
    report("POST-APPLY VERIFY", verify);
    const remaining = verify.valueFix + verify.columnCorrupt;
    if (remaining > 0) {
      console.error(
        `\n❌ SELF-VALIDATION FAILED: ${remaining} coinsurance entries still non-compliant after apply ` +
          `(${verify.valueFix} value, ${verify.columnCorrupt} column). Investigate before trusting the seed.`,
      );
      process.exit(1);
    }
    console.log(`\n✓ SELF-VALIDATION PASSED: 0 coinsurance entries non-compliant after apply.`);
  } else {
    const would = pass1.valueFix + pass1.columnCorrupt;
    console.log(
      `\nDry-run complete. WOULD fix ${would} coinsurance entries ` +
        `(${pass1.valueFix} value-only, ${pass1.columnCorrupt} column-corrupt). Re-run with --apply to write.`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
