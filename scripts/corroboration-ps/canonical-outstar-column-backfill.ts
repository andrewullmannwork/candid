/**
 * N3 — Canonical out_* column recovery backfill (S245 — Group B cold-start §14 gate, data side, part 2).
 *
 * Sibling to canonical-coinsurance-value-backfill.ts (N2). N2 fixed the VALUE side (coinsurance
 * provenance value := normalized column). This fixes the COLUMN side: the §14 probe found ~1362
 * value≠column on canonical_plan_services, ALL of the shape `out_* column = NULL while field_provenance
 * carries the value`. Root cause: the seed promoted out_* via apply_promotion_event BEFORE mig 187 added
 * the out_* typed-column arms, so the RPC wrote field_provenance.out_* but had no arm to write the column.
 * The data is REAL (admin_attested @ 0.9; out_coinsurance/out_copay values are widely varied + realistic,
 * not a uniform default) — it is stranded, not assumed. This recovers it into the typed columns so the OON
 * cost-sharing is queryable (consumers + the unified engine read columns) and §14 #3 (column==value) holds.
 *
 * Per out_* field (out_copay, out_coinsurance, out_deductible_applies) where a provenance entry has a value:
 *   - RECOVER  : column IS NULL and provenance value present -> set column := value (typed; coinsurance
 *                re-normalized to decimal as belt-and-suspenders). [the stranded case — the safe fix]
 *   - MISMATCH : column NON-null and != value -> REPORTED ONLY, never auto-overwritten (ambiguous; investigate).
 *   - OK       : column == value.
 *
 * SELF-VALIDATING: after --apply it RE-SCANS read-only and asserts 0 recoverable (column-null+value) remain
 * (exits nonzero + loud otherwise). Dry-run reports the buckets without writing.
 *
 * DRY-RUN default (READ-ONLY). --apply writes. Idempotent. Aggregate output (values are numbers/booleans,
 * not PII; any string redacted). Service-role admin maintenance on canonical (Andrew-approved N3; the
 * sanctioned non-user-facing canonical-write path; recovers real stranded data, does not invent it).
 * Updates ONLY the out_* typed column (provenance untouched; the mig-173 net is legacy<->aligned and never
 * touches out_*, so no net interaction).
 *
 *   npx tsx scripts/corroboration-ps/canonical-outstar-column-backfill.ts          # dry-run (read-only)
 *   npx tsx scripts/corroboration-ps/canonical-outstar-column-backfill.ts --apply  # write
 */
import { config } from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";

const ENV_CANDIDATES = [
  resolve(__dirname, "../../.env.local"),
  resolve(__dirname, "../../../../../.env.local"),
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
const NUMERIC_OUT = ["out_copay", "out_coinsurance"] as const;
const BOOLEAN_OUT = ["out_deductible_applies"] as const;
const OUT_FIELDS = [...NUMERIC_OUT, ...BOOLEAN_OUT];
const COINS = new Set(["out_coinsurance"]);
const EPS = 1e-9;

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE_KEY as string, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type ProvEntry = Record<string, unknown>;
type Row = { id: string; field_provenance: Record<string, ProvEntry> | null } & Record<string, unknown>;

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}
function toBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v === "true" ? true : v === "false" ? false : null;
  return Boolean(v);
}
function redact(v: unknown): string {
  return typeof v === "string" ? `[str:${v.length}]` : JSON.stringify(v);
}

interface Stat {
  rowsScanned: number;
  recovered: Record<string, number>;
  mismatch: Record<string, number>; // column non-null and != value (reported, NOT changed)
  ok: Record<string, number>;
  rowsUpdated: number;
  samples: string[];
  mismatchSamples: string[];
}

function newStat(): Stat {
  return {
    rowsScanned: 0,
    recovered: Object.fromEntries(OUT_FIELDS.map((f) => [f, 0])),
    mismatch: Object.fromEntries(OUT_FIELDS.map((f) => [f, 0])),
    ok: Object.fromEntries(OUT_FIELDS.map((f) => [f, 0])),
    rowsUpdated: 0,
    samples: [],
    mismatchSamples: [],
  };
}

/** typed recovery value for a field, or undefined if not recoverable */
function recoveredValue(field: string, entryVal: unknown): number | boolean | null {
  if (COINS.has(field)) return normalizeCoinsuranceForStorage(toNum(entryVal)); // decimal, idempotent
  if ((NUMERIC_OUT as readonly string[]).includes(field)) return toNum(entryVal);
  return toBool(entryVal);
}
function matches(field: string, entryVal: unknown, colVal: unknown): boolean {
  if ((NUMERIC_OUT as readonly string[]).includes(field)) {
    const a = toNum(entryVal);
    const b = toNum(colVal);
    if (a === null || b === null) return a === b;
    return Math.abs(a - b) < EPS;
  }
  return toBool(entryVal) === toBool(colVal);
}

async function verifyColumns(): Promise<void> {
  const { data, error } = await sb.from(TABLE).select("*").limit(1);
  if (error) { console.error(`${TABLE} column-verify error:`, error.message); process.exit(1); }
  const sample = (data ?? [])[0];
  if (!sample) { console.error(`${TABLE} empty.`); process.exit(1); }
  const need = ["id", "field_provenance", ...OUT_FIELDS];
  const missing = need.filter((k) => !(k in sample));
  if (missing.length) { console.error(`${TABLE} missing columns: ${missing.join(", ")}`); process.exit(1); }
  console.log(`✓ ${TABLE} columns verified: ${need.join(", ")}`);
}

async function processTable(doWrite: boolean): Promise<Stat> {
  const stat = newStat();
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from(TABLE)
      .select(["id", "field_provenance", ...OUT_FIELDS].join(", "))
      .not("field_provenance", "is", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) { console.error(`${TABLE} scan error:`, error.message); process.exit(1); }
    const rows = (data ?? []) as unknown as Row[];
    if (rows.length === 0) break;

    for (const row of rows) {
      stat.rowsScanned++;
      const prov = row.field_provenance;
      if (!prov || typeof prov !== "object") continue;

      const patch: Record<string, number | boolean | null> = {};
      let rowChanged = false;

      for (const field of OUT_FIELDS) {
        const entry = prov[field];
        if (!entry || typeof entry !== "object" || !("value" in entry)) continue;
        const entryVal = (entry as ProvEntry).value;
        if (entryVal === null || entryVal === undefined) continue; // nothing to recover
        const colVal = row[field];

        if (colVal === null || colVal === undefined) {
          // STRANDED -> recover column from provenance value
          const rv = recoveredValue(field, entryVal);
          if (rv === null) continue; // unparseable; skip (shouldn't happen for real data)
          patch[field] = rv;
          stat.recovered[field]++;
          rowChanged = true;
          if (stat.samples.length < 12) stat.samples.push(`${field} ${String(row.id).slice(0, 8)}: col=null -> ${String(rv)} (prov ${redact(entryVal)})`);
        } else if (!matches(field, entryVal, colVal)) {
          // both non-null and differ -> REPORT only (ambiguous; never auto-overwrite)
          stat.mismatch[field]++;
          if (stat.mismatchSamples.length < 12) stat.mismatchSamples.push(`${field} ${String(row.id).slice(0, 8)}: col=${redact(colVal)} != prov=${redact(entryVal)}`);
        } else {
          stat.ok[field]++;
        }
      }

      if (rowChanged && doWrite) {
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

function totals(s: Stat) {
  const rec = OUT_FIELDS.reduce((a, f) => a + s.recovered[f], 0);
  const mis = OUT_FIELDS.reduce((a, f) => a + s.mismatch[f], 0);
  return { rec, mis };
}

function report(label: string, s: Stat): void {
  const { rec, mis } = totals(s);
  console.log(`\n=== ${label} (${TABLE}) ===`);
  console.log(`  rows scanned (with provenance): ${s.rowsScanned}`);
  for (const f of OUT_FIELDS) {
    console.log(`  ${f.padEnd(22)} recover=${s.recovered[f]}  ok=${s.ok[f]}  ${s.mismatch[f] ? "⚠ " : ""}mismatch(reported)=${s.mismatch[f]}`);
  }
  console.log(`  TOTAL recover=${rec}  mismatch(reported, untouched)=${mis}`);
  console.log(`  rows updated: ${APPLY ? s.rowsUpdated : "(dry-run — 0)"}`);
  for (const m of s.samples.slice(0, 8)) console.log(`     recover: ${m}`);
  for (const m of s.mismatchSamples.slice(0, 8)) console.log(`     ⚠ mismatch: ${m}`);
}

async function main(): Promise<void> {
  console.log(`MODE: ${APPLY ? "APPLY (writing canonical_plan_services out_* columns)" : "DRY-RUN (read-only)"}`);
  await verifyColumns();

  const pass1 = await processTable(APPLY);
  report(APPLY ? "APPLY PASS" : "DRY-RUN", pass1);

  if (APPLY) {
    const verify = await processTable(false);
    report("POST-APPLY VERIFY", verify);
    const remaining = totals(verify).rec;
    if (remaining > 0) {
      console.error(`\n❌ SELF-VALIDATION FAILED: ${remaining} out_* columns still recoverable (null+value) after apply.`);
      process.exit(1);
    }
    console.log(`\n✓ SELF-VALIDATION PASSED: 0 recoverable out_* columns remain.` + (totals(verify).mis ? `  (⚠ ${totals(verify).mis} non-null mismatches remain — reported, investigate separately)` : ""));
  } else {
    const { rec, mis } = totals(pass1);
    console.log(`\nDry-run complete. WOULD recover ${rec} out_* columns from provenance.` +
      (mis ? `  ⚠ ${mis} non-null mismatches will be REPORTED (not changed) — review above.` : "") +
      ` Re-run with --apply to write.`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
