/**
 * Corroboration-PS value-key backfill (S213 — Part 1 sub-part 4 + D2).
 *
 * The Pattern-1 evaluator counts `field_provenance->field->'value'`. Rows written before the
 * S205/#204 value-wiring carry provenance entries WITHOUT a 'value' key → invisible to corroboration.
 * This backfills `value` = the stored typed column for every such entry, exactly matching what the
 * write-path now produces. The column ALREADY holds the storage representation (e.g. coinsurance is
 * the stored decimal 0.4, booleans are as-is), so `value = column` verbatim — NO re-normalization.
 *
 * SELF-VALIDATING: for entries that ALREADY carry a value (post-#204 writes), it asserts
 * value === column and reports every mismatch. A clean dry-run (0 mismatches) is the empirical proof
 * that "value = column" matches the write-path, BEFORE any --apply touches data. Any mismatch halts
 * the case for applying until investigated.
 *
 * DRY-RUN default (READ-ONLY). --apply writes. Idempotent. Aggregate output only (string column
 * values are redacted in samples — no PII to console/logs).
 *
 *   npx tsx scripts/corroboration-ps/value-key-backfill.ts            # dry-run (read-only)
 *   npx tsx scripts/corroboration-ps/value-key-backfill.ts --apply    # write
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

type ProvEntry = Record<string, unknown>;
type Row = { id: string; field_provenance: Record<string, ProvEntry> | null } & Record<string, unknown>;

const COINS_FIELDS = new Set(["in_coinsurance", "out_coinsurance"]);

interface TableStat {
  rowsScanned: number;
  rowsWithProvenance: number;
  entriesBackfilled: number;
  coinsRepaired: number;
  rowsToUpdate: number;
  rowsUpdated: number;
  alreadyValued: number;
  mismatches: Array<{ id: string; field: string; column: string; stored: string }>;
  skippedNonColumn: Set<string>;
}

function redact(v: unknown): string {
  if (typeof v === "string") return `[str:${v.length}]`;
  return JSON.stringify(v);
}

async function processTable(table: string): Promise<TableStat> {
  const stat: TableStat = {
    rowsScanned: 0, rowsWithProvenance: 0, entriesBackfilled: 0, coinsRepaired: 0, rowsToUpdate: 0,
    rowsUpdated: 0, alreadyValued: 0, mismatches: [], skippedNonColumn: new Set<string>(),
  };
  const pageSize = 500;
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from(table)
      .select("*")
      .not("field_provenance", "is", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) { console.error(`${table} query error:`, error.message); process.exit(1); }
    const rows = (data ?? []) as Row[];
    if (rows.length === 0) break;

    for (const row of rows) {
      stat.rowsScanned++;
      const prov = row.field_provenance;
      if (!prov || typeof prov !== "object") continue;
      stat.rowsWithProvenance++;

      let rowChanged = false;
      const nextProv: Record<string, ProvEntry> = { ...prov };

      for (const [field, entry] of Object.entries(prov)) {
        if (!entry || typeof entry !== "object") continue;
        const col = row[field]; // provenance key == column name (buildProvenanceEntry contract)
        if (col === undefined) { stat.skippedNonColumn.add(field); continue; } // not a typed column
        if (col === null) continue; // nothing stored to mirror

        if ("value" in entry) {
          if (JSON.stringify(entry.value) === JSON.stringify(col)) { stat.alreadyValued++; continue; }
          if (COINS_FIELDS.has(field)) {
            // REPAIR: coinsurance value MUST equal its (uniformly-decimal) column. Fixes the historical
            // percent/decimal split (value=20 vs column=0.2) that silently breaks coinsurance corroboration.
            // The column is the source of truth (drives display + dollar-math); robust to any value drift.
            nextProv[field] = { ...entry, value: col };
            stat.coinsRepaired++;
            rowChanged = true;
            continue;
          }
          // Non-coinsurance value≠column: report only, do NOT overwrite (e.g. annual_limit text-vs-number;
          // the existing value may be the more useful representation). Surfaced for review, never clobbered.
          if (stat.mismatches.length < 50) {
            stat.mismatches.push({ id: row.id, field, column: redact(col), stored: redact(entry.value) });
          }
          continue;
        }
        nextProv[field] = { ...entry, value: col };
        stat.entriesBackfilled++;
        rowChanged = true;
      }

      if (rowChanged) {
        stat.rowsToUpdate++;
        if (APPLY) {
          const { error: upErr } = await sb.from(table).update({ field_provenance: nextProv }).eq("id", row.id);
          if (upErr) console.error(`  update ${table} ${row.id} failed:`, upErr.message);
          else stat.rowsUpdated++;
        }
      }
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return stat;
}

function report(table: string, s: TableStat): void {
  console.log(`\n=== ${table} ===`);
  console.log(`  rows with provenance / scanned: ${s.rowsWithProvenance} / ${s.rowsScanned}`);
  console.log(`  entries already valued + consistent: ${s.alreadyValued}`);
  console.log(`  value-key ADDED (was missing): ${s.entriesBackfilled}`);
  console.log(`  coinsurance REPAIRED (percent→decimal=column): ${s.coinsRepaired}`);
  console.log(`  rows to update: ${s.rowsToUpdate}${APPLY ? ` (updated ${s.rowsUpdated})` : ""}`);
  console.log(`  non-column provenance keys skipped: ${[...s.skippedNonColumn].join(", ") || "(none)"}`);
  console.log(`  ${s.mismatches.length > 0 ? "⚠ " : ""}other (non-coins) value≠column — REPORTED, not changed: ${s.mismatches.length}`);
  for (const m of s.mismatches.slice(0, 12)) {
    console.log(`     ${String(m.id).slice(0, 8)} ${m.field}: column=${m.column} stored=${m.stored}`);
  }
}

async function main(): Promise<void> {
  console.log(`MODE: ${APPLY ? "APPLY (writing)" : "DRY-RUN (read-only)"}`);
  let added = 0, repaired = 0, otherMismatch = 0;
  for (const table of ["plan_covered_services", "insurance_plans"]) {
    const s = await processTable(table);
    report(table, s);
    added += s.entriesBackfilled; repaired += s.coinsRepaired; otherMismatch += s.mismatches.length;
  }
  console.log(`\nDone (${APPLY ? "applied" : "dry-run"}). value-keys added: ${added} · coinsurance repaired: ${repaired} · ` +
    `other mismatches (reported, untouched): ${otherMismatch}` +
    (otherMismatch > 0 ? "  ⚠ review the non-coinsurance mismatches above" : ""));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
