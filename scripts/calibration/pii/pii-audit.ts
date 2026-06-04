/**
 * Ing-E Phase 1 — read-only PII audit (Ship Gate G2 baseline).
 *
 * Sweeps every SWEPT canonical/cross-user free-text surface in PROD, runs the
 * Phase-0 pattern library, and reports per-(surface, pattern) match counts +
 * header-bleed-vs-inherent stratification + document_ref filename check.
 *
 * STRICTLY READ-ONLY + NON-MUTATING (feedback_calibration_independence).
 *
 * PII-handling discipline:
 *   - Console + ing-e-baseline.json  → AGGREGATE COUNTS ONLY (no raw excerpt text).
 *   - Raw adjudication sample (PII)  → LOCAL ONLY at ~/Downloads/ing-e-adjudication-sample.csv
 *     (never vault, never committed; delete after adjudication).
 *
 * Run from the worktree root: npx tsx scripts/calibration/pii/pii-audit.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
import { writeFileSync } from "fs";
import { homedir } from "os";
import { createClient } from "@supabase/supabase-js";
import { findPiiMatches, hasCoverageTokens } from "@/lib/parser/pii-patterns";
import { redactText } from "@/lib/parser/pii-redactor";
import { SWEPT_SURFACES, type CanonicalSurface } from "./surfaces";

config({ path: resolve(process.cwd(), ".env.local") });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

const PAGE = 1000;
const N_MATCHED_SAMPLE = 20;
const N_UNMATCHED_SAMPLE = 12;
const POOL_CAP = 3000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRYRUN = !!process.env.REDACT_DRYRUN; // forced-ON redactText over real units (coverage/idempotency asserts)

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

interface Unit {
  rowId: string;
  field?: string;
  text: string;
  docRef?: string | null;
}

function extractUnits(surface: CanonicalSurface, row: Record<string, unknown>, rowId: string): Unit[] {
  const col = row[surface.column];
  const units: Unit[] = [];
  if (col == null) return units;
  switch (surface.kind) {
    case "text_column": {
      const t = asString(col);
      if (t && t.length) units.push({ rowId, text: t });
      break;
    }
    case "text_array": {
      // Postgres TEXT[] → supabase-js returns a JS array of strings; scan each.
      for (const el of asArray(col)) {
        const t = asString(el);
        if (t && t.length) units.push({ rowId, text: t });
      }
      break;
    }
    case "jsonb_blob": {
      const t = typeof col === "string" ? col : JSON.stringify(col);
      if (t && t.length > 2) units.push({ rowId, text: t });
      break;
    }
    case "jsonb_array_field": {
      for (const el of asArray(col)) {
        const o = asObj(el);
        const t = o ? asString(o[surface.arrayField ?? ""]) : null;
        if (t && t.length) units.push({ rowId, text: t });
      }
      break;
    }
    case "jsonb_provenance_sources_excerpt": {
      const fp = asObj(col);
      if (fp) {
        for (const [field, entry] of Object.entries(fp)) {
          const e = asObj(entry);
          if (!e) continue;
          for (const s of asArray(e.sources)) {
            const so = asObj(s);
            const t = so ? asString(so.excerpt) : null;
            if (t && t.length) units.push({ rowId, field, text: t, docRef: so ? asString(so.document_ref) : null });
          }
        }
      }
      break;
    }
  }
  return units;
}

interface PatternAgg {
  auto: number;
  review: number;
  suppressed: number;
}
interface SurfaceResult {
  id: string;
  tier: number;
  visibility: string;
  rowsScanned: number;
  unitsScanned: number;
  unitsWithAnyMatch: number;
  unitsWithAutoMatch: number;
  autoMatchTotal: number;
  reviewMatchTotal: number;
  suppressedTotal: number;
  perPattern: Record<string, PatternAgg>;
  bleedUnits: number;
  standaloneUnits: number;
  docRefsChecked: number;
  nonUuidDocRefs: number;
  dryrunRedacted: number;
  dryrunCoverageLoss: number;
  dryrunNonIdempotent: number;
  error?: string;
}

// sample text stays LOCAL ONLY (never console / baseline / git)
interface SampleRow {
  surfaceId: string;
  rowId: string;
  field: string;
  hasAutoMatch: boolean;
  autoPatterns: string;
  reviewPatterns: string;
  text: string;
}

function evenSample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const out: T[] = [];
  const step = arr.length / n;
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

async function fetchAll(table: string, columns: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...(data as unknown as Record<string, unknown>[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function auditSurface(
  surface: CanonicalSurface,
  matchedPool: SampleRow[],
  unmatchedPool: SampleRow[],
): Promise<SurfaceResult> {
  const res: SurfaceResult = {
    id: surface.id, tier: surface.tier, visibility: surface.visibility,
    rowsScanned: 0, unitsScanned: 0, unitsWithAnyMatch: 0, unitsWithAutoMatch: 0,
    autoMatchTotal: 0, reviewMatchTotal: 0, suppressedTotal: 0,
    perPattern: {}, bleedUnits: 0, standaloneUnits: 0, docRefsChecked: 0, nonUuidDocRefs: 0,
    dryrunRedacted: 0, dryrunCoverageLoss: 0, dryrunNonIdempotent: 0,
  };
  let rows: Record<string, unknown>[] = [];
  let hasId = true;
  try {
    rows = await fetchAll(surface.table, `id, ${surface.column}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/does not exist/.test(msg)) {
      // table has a non-`id` PK — refetch the column alone, use a synthetic rowId
      try {
        rows = await fetchAll(surface.table, surface.column);
        hasId = false;
      } catch (e2) {
        res.error = (e2 as Error).message;
        return res;
      }
    } else {
      res.error = msg;
      return res;
    }
  }
  res.rowsScanned = rows.length;
  const localMatched: SampleRow[] = [];
  const localUnmatched: SampleRow[] = [];

  let idx = 0;
  for (const row of rows) {
    const rowId = hasId ? String(row.id ?? `row#${idx}`) : `row#${idx}`;
    idx++;
    for (const unit of extractUnits(surface, row, rowId)) {
      res.unitsScanned++;
      if (unit.docRef !== undefined) {
        res.docRefsChecked++;
        if (unit.docRef && !UUID_RE.test(unit.docRef)) res.nonUuidDocRefs++;
      }
      const matches = findPiiMatches(unit.text);
      const autoM = matches.filter((m) => m.confidence === "auto" && !m.suppressedByCoverageGuard);
      const reviewM = matches.filter((m) => m.confidence === "review");
      const suppM = matches.filter((m) => m.suppressedByCoverageGuard);
      for (const m of matches) {
        const p = (res.perPattern[m.patternName] ??= { auto: 0, review: 0, suppressed: 0 });
        if (m.suppressedByCoverageGuard) p.suppressed++;
        else if (m.confidence === "auto") p.auto++;
        else p.review++;
      }
      res.autoMatchTotal += autoM.length;
      res.reviewMatchTotal += reviewM.length;
      res.suppressedTotal += suppM.length;
      const anyActionable = autoM.length + reviewM.length > 0;
      if (anyActionable) {
        res.unitsWithAnyMatch++;
        if (autoM.length) res.unitsWithAutoMatch++;
        if (hasCoverageTokens(unit.text)) res.bleedUnits++;
        else res.standaloneUnits++;
      }
      if (DRYRUN) {
        // Forced-ON: run the ACTUAL write-path transform over the real unit and
        // assert it never drops a coverage token + is idempotent.
        const red = redactText(unit.text);
        if (red.changed) res.dryrunRedacted++;
        if (hasCoverageTokens(unit.text) && !hasCoverageTokens(red.redacted)) res.dryrunCoverageLoss++;
        if (redactText(red.redacted).redacted !== red.redacted) res.dryrunNonIdempotent++;
      }
      const sample: SampleRow = {
        surfaceId: surface.id, rowId: unit.rowId, field: unit.field ?? "",
        hasAutoMatch: autoM.length > 0,
        autoPatterns: [...new Set(autoM.map((m) => m.patternName))].join("|"),
        reviewPatterns: [...new Set(reviewM.map((m) => m.patternName))].join("|"),
        text: unit.text,
      };
      if (anyActionable) {
        if (localMatched.length < POOL_CAP) localMatched.push(sample);
      } else if (localUnmatched.length < POOL_CAP) {
        localUnmatched.push(sample);
      }
    }
  }
  matchedPool.push(...evenSample(localMatched, N_MATCHED_SAMPLE));
  unmatchedPool.push(...evenSample(localUnmatched, N_UNMATCHED_SAMPLE));
  return res;
}

function csv(s: string): string {
  const v = s.replace(/\r?\n/g, " ⏎ ");
  return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

async function main(): Promise<void> {
  const matchedPool: SampleRow[] = [];
  const unmatchedPool: SampleRow[] = [];
  const results: SurfaceResult[] = [];
  for (const surface of SWEPT_SURFACES) {
    results.push(await auditSurface(surface, matchedPool, unmatchedPool));
  }

  // ─── console: AGGREGATE ONLY (no raw text) ───
  console.log("════════════════════════════════════════════════════════════════════");
  console.log(" Ing-E PII audit — PROD read-only (aggregate; no raw text printed)");
  console.log("════════════════════════════════════════════════════════════════════");
  const globalPattern: Record<string, PatternAgg> = {};
  let totUnits = 0, totAutoUnits = 0, totBleed = 0, totStandalone = 0, totNonUuid = 0;
  for (const r of results) {
    if (r.error) {
      console.log(`\n[T${r.tier}] ${r.id}\n   ⚠️  unavailable: ${r.error}`);
      continue;
    }
    totUnits += r.unitsScanned;
    totAutoUnits += r.unitsWithAutoMatch;
    totBleed += r.bleedUnits;
    totStandalone += r.standaloneUnits;
    totNonUuid += r.nonUuidDocRefs;
    for (const [name, agg] of Object.entries(r.perPattern)) {
      const g = (globalPattern[name] ??= { auto: 0, review: 0, suppressed: 0 });
      g.auto += agg.auto; g.review += agg.review; g.suppressed += agg.suppressed;
    }
    const bleedPct = r.unitsWithAnyMatch ? Math.round((r.bleedUnits / r.unitsWithAnyMatch) * 100) : 0;
    console.log(
      `\n[T${r.tier}] ${r.id}` +
      `\n   rows=${r.rowsScanned} units=${r.unitsScanned} | unitsWithAuto=${r.unitsWithAutoMatch} unitsWithAny=${r.unitsWithAnyMatch}` +
      `\n   autoMatches=${r.autoMatchTotal} reviewMatches=${r.reviewMatchTotal} suppressedByGuard=${r.suppressedTotal}` +
      `\n   bleed(co-located w/ coverage)=${r.bleedUnits} standalone=${r.standaloneUnits} (${bleedPct}% bleed)` +
      (r.docRefsChecked ? `\n   document_ref: checked=${r.docRefsChecked} nonUUID=${r.nonUuidDocRefs}` : ""),
    );
  }
  console.log("\n── per-pattern totals (all surfaces) ──");
  for (const [name, agg] of Object.entries(globalPattern).sort((a, b) => (b[1].auto + b[1].review) - (a[1].auto + a[1].review))) {
    console.log(`   ${name.padEnd(28)} auto=${agg.auto}  review=${agg.review}  suppressed=${agg.suppressed}`);
  }
  console.log("\n── totals ──");
  console.log(`   surfaces swept: ${results.filter((r) => !r.error).length}/${results.length}`);
  console.log(`   units scanned: ${totUnits}`);
  console.log(`   units with AUTO match (would-redact): ${totAutoUnits}`);
  console.log(`   bleed vs standalone (matched units): ${totBleed} / ${totStandalone}`);
  console.log(`   non-UUID document_refs: ${totNonUuid}`);
  if (DRYRUN) {
    let dRed = 0, dLoss = 0, dNonIdem = 0;
    for (const r of results) { if (r.error) continue; dRed += r.dryrunRedacted; dLoss += r.dryrunCoverageLoss; dNonIdem += r.dryrunNonIdempotent; }
    console.log("\n── forced-ON redactText dry-run (real units) ──");
    console.log(`   units redacted: ${dRed}   coverage-token losses: ${dLoss}   non-idempotent: ${dNonIdem}`);
  }

  // ─── baseline JSON (aggregate; NO raw text) → worktree (committable) ───
  const baseline = {
    generated_for: "Ing-E Phase 1 PII audit baseline (S165)",
    note: "Aggregate counts only — NO raw excerpt text (PII discipline). Raw sample is local-only.",
    target: "0 auto-match PII units in canonical Tier-1 post-backfill",
    totals: { surfaces_swept: results.filter((r) => !r.error).length, units_scanned: totUnits, units_with_auto_match: totAutoUnits, bleed_units: totBleed, standalone_units: totStandalone, non_uuid_doc_refs: totNonUuid },
    per_pattern: globalPattern,
    per_surface: results,
  };
  const baselinePath = resolve(process.cwd(), "scripts/calibration/pii/ing-e-baseline.json");
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  console.log(`\nWrote baseline (aggregate, no PII): ${baselinePath}`);

  // ─── adjudication sample (RAW text) → LOCAL ONLY (~/Downloads) ───
  if (process.env.AUDIT_NO_SAMPLE) {
    console.log("\n(AUDIT_NO_SAMPLE set — re-audit aggregate only; raw sample NOT regenerated)");
    return;
  }
  const sample = [...matchedPool, ...unmatchedPool];
  const header = "surface_id,row_id,field,has_auto_match,auto_patterns,review_patterns,text,is_pii_y_n,pii_types,coverage_corruption_risk_y_n";
  const lines = sample.map((s) =>
    [csv(s.surfaceId), csv(s.rowId), csv(s.field), s.hasAutoMatch ? "y" : "n", csv(s.autoPatterns), csv(s.reviewPatterns), csv(s.text), "", "", ""].join(","),
  );
  const samplePath = resolve(homedir(), "Downloads", "ing-e-adjudication-sample.csv");
  writeFileSync(samplePath, [header, ...lines].join("\n"));
  console.log(`\nWrote adjudication sample (RAW — LOCAL ONLY, delete after): ${samplePath}`);
  console.log(`   sample rows: ${sample.length} (matched=${matchedPool.length}, unmatched=${unmatchedPool.length})`);
  console.log("   → label is_pii_y_n + pii_types + coverage_corruption_risk_y_n; return for precision+recall.");
}

main().catch((e) => {
  console.error("AUDIT FAILED:", (e as Error).message);
  process.exit(1);
});
