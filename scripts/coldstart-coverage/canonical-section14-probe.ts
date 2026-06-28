/**
 * §14 canonical validation probe (S245 — Group B cold-start, step 2b). READ-ONLY.
 *
 * The independent, non-mutating oracle for the §14 corroboration value-wiring contract on
 * canonical_plan_services (separate from the N2/N3 correctors by design — a fixer must not grade itself).
 * Scans every cite-grade field (the SoT set mirrored from promotion-event.ts CITE_GRADE_FIELDS) and:
 *
 *   HARD GATES (exit nonzero if any > 0 — these must hold on the live seed today):
 *     - percent-coins   : an in/out_coinsurance provenance value > 1 (must be decimal ∈ [0,1]; §14 #3) — N2.
 *     - missing-value   : a cite-grade provenance entry with no `value` key (invisible to corroboration; §14 #2)
 *     - stranded value≠column : a provenance value present while its typed COLUMN is null (recoverable; §14 #3) — N3.
 *
 *   REPORTED (no gate — baselines the cold-start REGEN closes at step 5, not pass/fail today):
 *     - ambiguous value≠column : column AND provenance both non-null but disagree. Can't be auto-resolved from
 *       data (e.g. a pre-187 correction that updated the column but not provenance); the regen re-extracts from
 *       source = authoritative. (S245: 5 out_copay rows.)
 *     - excerpt-coverage: % of cite-grade entries carrying a non-empty source_excerpt, overall + per-field.
 *       Existing seed is ~0% (loaded without excerpts); the regen earns these (the ≥80% excerpt gate lands at
 *       step 5 on quote-backed fields over regenerated plans — Andrew-approved framing).
 *     - boolean distribution: true/false/null for covered / in_deductible_applies / prior_auth_required columns
 *       — quantifies how much of the seed was default-ASSUMED (the mig-189 drift) vs evidence; the regen re-derives.
 *
 * Aggregate output only (values are numbers/booleans, not PII; any string is redacted).
 *
 *   npx tsx scripts/coldstart-coverage/canonical-section14-probe.ts
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

const TABLE = "canonical_plan_services";
const EPS = 1e-9;

// Mirror of promotion-event.ts CITE_GRADE_FIELDS (the SoT cite-grade set).
const NUMERIC_FIELDS = ["in_copay", "in_coinsurance", "out_copay", "out_coinsurance", "annual_limit", "visit_limit"];
const BOOLEAN_FIELDS = ["in_deductible_applies", "covered", "prior_auth_required", "out_deductible_applies", "requires_referral"];
const CITE_GRADE_FIELDS = [...NUMERIC_FIELDS, ...BOOLEAN_FIELDS];
const COINS_FIELDS = new Set(["in_coinsurance", "out_coinsurance"]);
const NUMERIC_SET = new Set(NUMERIC_FIELDS);
const DIST_BOOLEANS = ["covered", "in_deductible_applies", "prior_auth_required"];

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
function redact(v: unknown): string {
  return typeof v === "string" ? `[str:${v.length}]` : JSON.stringify(v);
}
function isNull(v: unknown): boolean {
  return v === null || v === undefined;
}
function valuesMatch(field: string, entryVal: unknown, colVal: unknown): boolean {
  if (NUMERIC_SET.has(field)) {
    const a = toNum(entryVal);
    const b = toNum(colVal);
    if (a === null || b === null) return a === b;
    return Math.abs(a - b) < EPS;
  }
  const norm = (v: unknown): boolean | null =>
    v === null || v === undefined ? null : typeof v === "string" ? v === "true" : Boolean(v);
  return norm(entryVal) === norm(colVal);
}

interface Stats {
  rowsScanned: number;
  rowsWithProv: number;
  entriesByField: Record<string, number>;
  excerptByField: Record<string, number>;
  percentCoins: number;
  strandedNeq: number; // value present, column null — HARD (N3 recovers)
  ambiguousNeq: number; // both non-null, differ — REPORTED (regen-fixed)
  missingValue: number;
  boolDist: Record<string, { true: number; false: number; null: number }>;
  samples: { percent: string[]; stranded: string[]; ambiguous: string[]; missing: string[] };
}

async function main(): Promise<void> {
  console.log(`§14 canonical probe (READ-ONLY) over ${TABLE} — ${CITE_GRADE_FIELDS.length} cite-grade fields\n`);

  const s: Stats = {
    rowsScanned: 0, rowsWithProv: 0,
    entriesByField: Object.fromEntries(CITE_GRADE_FIELDS.map((f) => [f, 0])),
    excerptByField: Object.fromEntries(CITE_GRADE_FIELDS.map((f) => [f, 0])),
    percentCoins: 0, strandedNeq: 0, ambiguousNeq: 0, missingValue: 0,
    boolDist: Object.fromEntries(DIST_BOOLEANS.map((f) => [f, { true: 0, false: 0, null: 0 }])),
    samples: { percent: [], stranded: [], ambiguous: [], missing: [] },
  };

  const { data: probe, error: probeErr } = await sb.from(TABLE).select("*").limit(1);
  if (probeErr) { console.error(`${TABLE} column-verify error:`, probeErr.message); process.exit(1); }
  const sample = (probe ?? [])[0];
  if (!sample) { console.error(`${TABLE} empty.`); process.exit(1); }
  const missingCols = ["id", "field_provenance", ...CITE_GRADE_FIELDS].filter((k) => !(k in sample));
  if (missingCols.length) { console.error(`${TABLE} missing columns: ${missingCols.join(", ")}`); process.exit(1); }

  const selectCols = ["id", "field_provenance", ...CITE_GRADE_FIELDS].join(", ");
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from(TABLE).select(selectCols).order("id", { ascending: true }).range(from, from + pageSize - 1);
    if (error) { console.error(`${TABLE} scan error:`, error.message); process.exit(1); }
    const rows = (data ?? []) as unknown as Row[];
    if (rows.length === 0) break;

    for (const row of rows) {
      s.rowsScanned++;

      for (const f of DIST_BOOLEANS) {
        const v = row[f];
        if (isNull(v)) s.boolDist[f].null++;
        else if (v === true) s.boolDist[f].true++;
        else s.boolDist[f].false++;
      }

      const prov = row.field_provenance;
      if (!prov || typeof prov !== "object") continue;
      s.rowsWithProv++;

      for (const f of CITE_GRADE_FIELDS) {
        const entry = prov[f];
        if (!entry || typeof entry !== "object") continue; // field not promoted on this row — not a §14 violation
        s.entriesByField[f]++;

        const ex = (entry as ProvEntry).source_excerpt;
        if (typeof ex === "string" && ex.trim().length > 0) s.excerptByField[f]++;

        if (!("value" in entry)) {
          s.missingValue++;
          if (s.samples.missing.length < 12) s.samples.missing.push(`${String(row.id).slice(0, 8)} ${f}`);
          continue;
        }
        const entryVal = (entry as ProvEntry).value;

        if (COINS_FIELDS.has(f)) {
          const n = toNum(entryVal);
          if (n !== null && n > 1) {
            s.percentCoins++;
            if (s.samples.percent.length < 12) s.samples.percent.push(`${String(row.id).slice(0, 8)} ${f}=${redact(entryVal)}`);
          }
        }

        if (!valuesMatch(f, entryVal, row[f])) {
          if (isNull(row[f])) {
            s.strandedNeq++;
            if (s.samples.stranded.length < 12) s.samples.stranded.push(`${String(row.id).slice(0, 8)} ${f}: value=${redact(entryVal)} col=null`);
          } else {
            s.ambiguousNeq++;
            if (s.samples.ambiguous.length < 12) s.samples.ambiguous.push(`${String(row.id).slice(0, 8)} ${f}: value=${redact(entryVal)} col=${redact(row[f])}`);
          }
        }
      }
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }

  const totalEntries = Object.values(s.entriesByField).reduce((a, b) => a + b, 0);
  const totalExcerpt = Object.values(s.excerptByField).reduce((a, b) => a + b, 0);
  console.log(`rows scanned: ${s.rowsScanned} · with field_provenance: ${s.rowsWithProv}`);
  console.log(`cite-grade entries examined: ${totalEntries}\n`);

  console.log("=== HARD GATES (must be 0 on the live seed today) ===");
  console.log(`  ${s.percentCoins ? "✗" : "✓"} percent-coins (in/out_coinsurance value>1): ${s.percentCoins}`);
  console.log(`  ${s.missingValue ? "✗" : "✓"} missing-value (entry without 'value'):  ${s.missingValue}`);
  console.log(`  ${s.strandedNeq ? "✗" : "✓"} stranded value≠column (col null):       ${s.strandedNeq}`);
  for (const m of s.samples.percent) console.log(`       percent : ${m}`);
  for (const m of s.samples.missing) console.log(`       missing : ${m}`);
  for (const m of s.samples.stranded) console.log(`       stranded: ${m}`);

  console.log("\n=== REPORTED baselines (the regen closes at step 5 — NOT a gate today) ===");
  console.log(`  ambiguous value≠column (both non-null, differ): ${s.ambiguousNeq}`);
  for (const m of s.samples.ambiguous) console.log(`       ambiguous: ${m}`);
  console.log(`  excerpt-coverage overall: ${totalExcerpt}/${totalEntries} (${totalEntries ? ((totalExcerpt / totalEntries) * 100).toFixed(2) : "0.00"}%)`);
  for (const f of CITE_GRADE_FIELDS) {
    const e = s.entriesByField[f];
    if (e === 0) continue;
    console.log(`    ${f.padEnd(22)} ${s.excerptByField[f]}/${e} (${((s.excerptByField[f] / e) * 100).toFixed(1)}%)`);
  }
  console.log("  boolean COLUMN distribution (assumed-true vs evidence):");
  for (const f of DIST_BOOLEANS) {
    const d = s.boolDist[f];
    console.log(`    ${f.padEnd(22)} true=${d.true}  false=${d.false}  null=${d.null}`);
  }

  const hardFail = s.percentCoins + s.missingValue + s.strandedNeq;
  console.log(`\n${hardFail === 0 ? "✓ §14 HARD GATES PASSED (0 violations)" : `✗ §14 HARD GATES FAILED (${hardFail} violations)`}` +
    (s.ambiguousNeq ? `  · ${s.ambiguousNeq} ambiguous + excerpts deferred to regen` : ""));
  process.exit(hardFail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
