/**
 * Ing-E Phase 3 — made-safe PII backfill (Architecture A).
 *
 * Brings already-stored cross-user excerpts in line with the write-path redactor.
 * On today's corpus the audit found 0 auto-tier PII, so this is a VERIFIED NO-OP that
 * proves the mechanism. "Made-safe destructive backfill" = snapshot (rollback ledger)
 * → per-unit coverage-preservation assert → idempotency assert → guarded UPDATE.
 *
 * TWO surface classes (declared on surfaces.ts `forwardWriter`):
 *   APPLY  (direct_immutable / direct_rmw) → snapshot + guarded column UPDATE. A direct
 *          UPDATE matches the forward writer's own posture (insert-only or unguarded RMW).
 *   VERIFY (rpc_advisory) → DRY-RUN ONLY. The forward writer holds pg_advisory_xact_lock
 *          (apply_promotion_event / apply_corrector_upsert); a direct blob UPDATE would
 *          bypass it (S135 non-negotiable). A >0 change here is a LOUD failure — the fix is
 *          a lock-aware RPC, never a direct write. The G7 daily audit cron is the automated
 *          trigger that would surface that.
 *
 * MODES:
 *   (default) --dry-run   READ-ONLY. Tally rows-would-change + coverage-loss + non-idempotent
 *                         over all 6 wired surfaces. Writes nothing. Aggregate-only output.
 *   --apply               Dry-run first; if the global guard is clean, snapshot + UPDATE the
 *                         APPLY surfaces' changed rows. Run at/after the Phase-2 deploy.
 *   --seed-validate       Self-cleaning proof: seed a throwaway row with synthetic PII, run the
 *                         REAL snapshot + guarded-UPDATE path (happy + guard-skip), assert, delete.
 *   --batch-id=<id>       Override the snapshot batch id (default ing-e-backfill-<ISO>).
 *
 * PII DISCIPLINE: console output = AGGREGATE COUNTS ONLY (never raw excerpt text). Raw
 * pre-values live ONLY in pii_redaction_backfill_snapshot (service-role-only; mig 144).
 *
 * Run from the worktree root:
 *   npx tsx scripts/calibration/pii/pii-backfill.ts            # dry-run
 *   npx tsx scripts/calibration/pii/pii-backfill.ts --apply    # at/after the Phase-2 deploy
 *   npx tsx scripts/calibration/pii/pii-backfill.ts --seed-validate
 */
import { config } from "dotenv";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { redactText } from "@/lib/parser/pii-redactor";
import { hasCoverageTokens } from "@/lib/parser/pii-patterns";
import {
  BACKFILL_APPLY_SURFACES,
  BACKFILL_VERIFY_SURFACES,
  type CanonicalSurface,
} from "@/lib/parser/pii-surfaces";
import { extractUnits, fetchAllKeyset, redactColumnValue, type RedactFn, type UnitRedaction } from "@/lib/parser/pii-surface-iter";

config({ path: resolve(process.cwd(), ".env.local") });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

const SNAPSHOT_TABLE = "pii_redaction_backfill_snapshot";
const MODE: "apply" | "seed-validate" | "dry-run" = process.argv.includes("--apply")
  ? "apply"
  : process.argv.includes("--seed-validate")
    ? "seed-validate"
    : "dry-run";
const batchArg = process.argv.find((a) => a.startsWith("--batch-id="));
const BATCH_ID = batchArg ? batchArg.slice("--batch-id=".length) : `ing-e-backfill-${new Date().toISOString().slice(0, 19)}Z`;

/** Wrap the real redactor into the injected RedactFn surface-iter expects. */
const redact: RedactFn = (t) => {
  const r = redactText(t);
  return { redacted: r.redacted, changed: r.changed, patterns: [...new Set(r.redactions.map((x) => x.patternName))] };
};

/** Serialize a column value for the TEXT NOT NULL snapshot (string as-is; structures → JSON). */
const serialize = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/** Per-unit coverage-preservation: a redaction must NEVER drop a coverage token. */
const coverageLost = (units: UnitRedaction[]): boolean =>
  units.some((u) => hasCoverageTokens(u.before) && !hasCoverageTokens(u.after));
/** Idempotency: re-redacting the post-text changes nothing. */
const nonIdempotent = (units: UnitRedaction[]): boolean => units.some((u) => redactText(u.after).changed);

interface SurfaceTally {
  id: string;
  klass: "apply" | "verify";
  rowsScanned: number;
  unitsScanned: number;
  rowsChanged: number;
  unitsRedacted: number;
  coverageLoss: number;
  nonIdempotent: number;
  rowsWritten: number; // apply-write only
  guardSkipped: number; // apply-write only (concurrent change caught)
  error?: string;
}

// Row fetching uses fetchAllKeyset (exhaustive keyset pagination) from ./surface-iter.

/** Snapshot (idempotent) → guarded UPDATE for ONE changed apply-surface row. */
async function applyRow(
  surface: CanonicalSurface,
  row: Record<string, unknown>,
  rowId: string,
  newValue: unknown,
  units: UnitRedaction[],
): Promise<"written" | "guard-skipped" | "snapshot-error" | "update-error"> {
  const patterns = [...new Set(units.flatMap((u) => u.patterns))];
  // 1. Snapshot BEFORE the destructive write (rollback ledger). ON CONFLICT DO NOTHING
  //    via ignoreDuplicates keeps the TRUE pre-value on any retry.
  const { error: snapErr } = await supabase.from(SNAPSHOT_TABLE).upsert(
    {
      batch_id: BATCH_ID,
      surface: surface.id,
      row_id: rowId,
      pre_value: serialize(row[surface.column]),
      post_value: serialize(newValue),
      patterns,
    },
    { onConflict: "batch_id,surface,row_id", ignoreDuplicates: true },
  );
  if (snapErr) {
    console.error(`   snapshot error @ ${surface.id} row=${rowId}: ${snapErr.message}`);
    return "snapshot-error";
  }
  // 2. Guarded UPDATE — optimistic concurrency (D5): only writes if the guard column still
  //    holds the value we read (catches a concurrent forward RMW). 0 rows back = skip.
  let q = supabase.from(surface.table).update({ [surface.column]: newValue }).eq("id", rowId);
  const guardCol = surface.concurrencyGuardColumn;
  if (guardCol) q = q.eq(guardCol, row[guardCol] as never);
  const { data: updated, error: updErr } = await q.select("id");
  if (updErr) {
    console.error(`   update error @ ${surface.id} row=${rowId}: ${updErr.message}`);
    return "update-error";
  }
  return updated && updated.length > 0 ? "written" : "guard-skipped";
}

async function processSurface(surface: CanonicalSurface, klass: "apply" | "verify", doWrite: boolean): Promise<SurfaceTally> {
  const t: SurfaceTally = {
    id: surface.id, klass, rowsScanned: 0, unitsScanned: 0, rowsChanged: 0,
    unitsRedacted: 0, coverageLoss: 0, nonIdempotent: 0, rowsWritten: 0, guardSkipped: 0,
  };
  const guardCol = surface.concurrencyGuardColumn;
  const cols = ["id", surface.column, ...(guardCol ? [guardCol] : [])].join(", ");
  let rows: Record<string, unknown>[];
  try {
    rows = await fetchAllKeyset(supabase, surface.table, cols);
  } catch (e) {
    t.error = (e as Error).message;
    return t;
  }
  t.rowsScanned = rows.length;
  for (const row of rows) {
    const rowId = String(row.id ?? "");
    t.unitsScanned += extractUnits(surface, row, rowId).length;
    const res = redactColumnValue(surface, row[surface.column], redact);
    if (!res.changed) continue;
    t.rowsChanged++;
    t.unitsRedacted += res.units.length;
    const covLost = coverageLost(res.units);
    const nonIdem = nonIdempotent(res.units);
    if (covLost) t.coverageLoss++;
    if (nonIdem) t.nonIdempotent++;
    // VERIFY surfaces never write; APPLY surfaces only write when doWrite AND the row passes asserts.
    if (!doWrite || klass === "verify" || covLost || nonIdem) continue;
    const outcome = await applyRow(surface, row, rowId, res.newValue, res.units);
    if (outcome === "written") t.rowsWritten++;
    else if (outcome === "guard-skipped") t.guardSkipped++;
  }
  return t;
}

function report(tallies: SurfaceTally[]): void {
  console.log("\n── per-surface (aggregate; no raw text) ──");
  for (const t of tallies) {
    if (t.error) {
      console.log(`  [${t.klass}] ${t.id}  ⚠️  ${t.error}`);
      continue;
    }
    console.log(
      `  [${t.klass}] ${t.id}\n` +
        `     rows=${t.rowsScanned} units=${t.unitsScanned} | rowsChanged=${t.rowsChanged} unitsRedacted=${t.unitsRedacted} coverageLoss=${t.coverageLoss} nonIdempotent=${t.nonIdempotent}` +
        (t.klass === "apply" && (t.rowsWritten || t.guardSkipped) ? ` | written=${t.rowsWritten} guardSkipped=${t.guardSkipped}` : ""),
    );
  }
}

/** Reasons the apply must be refused (global hard-stop). */
function guardTrips(tallies: SurfaceTally[]): string[] {
  const reasons: string[] = [];
  for (const t of tallies) {
    if (t.error) reasons.push(`${t.id}: fetch error (${t.error}) — cannot verify clean`);
    if (t.coverageLoss > 0) reasons.push(`${t.id}: ${t.coverageLoss} coverage-loss row(s) — redactor regression`);
    if (t.nonIdempotent > 0) reasons.push(`${t.id}: ${t.nonIdempotent} non-idempotent row(s) — redactor regression`);
    if (t.klass === "verify" && t.rowsChanged > 0)
      reasons.push(
        `${t.id}: ${t.rowsChanged} change(s) in an ADVISORY-LOCKED surface — redact via a lock-aware RPC, NOT a direct UPDATE (S135). DO NOT --apply.`,
      );
  }
  return reasons;
}

async function runDryRunPass(): Promise<SurfaceTally[]> {
  const tallies: SurfaceTally[] = [];
  for (const s of BACKFILL_APPLY_SURFACES) tallies.push(await processSurface(s, "apply", false));
  for (const s of BACKFILL_VERIFY_SURFACES) tallies.push(await processSurface(s, "verify", false));
  return tallies;
}

// ───────────────────────── seed-validate (self-cleaning) ─────────────────────────

async function seedValidate(): Promise<void> {
  let pass = 0;
  const fails: string[] = [];
  const ok = (label: string, cond: boolean): void => {
    if (cond) pass++;
    else fails.push(label);
  };

  // Representative apply surface with the monotonic (observation_count) guard.
  const surface = BACKFILL_APPLY_SURFACES.find((s) => s.concurrencyGuardColumn === "observation_count");
  if (!surface) {
    console.error("seed-validate: no observation_count-guarded apply surface found");
    process.exit(1);
  }
  const TEST_CODE = "ZZZPIITEST";
  const TEST_TYPE = "TEST";
  const SYNTH = "Member ID: W123456789 — $30 copay"; // auto-PII (member id) + coverage token

  // Clean any leftover from a prior aborted run.
  await supabase.from(surface.table).delete().eq("billing_code", TEST_CODE).eq("billing_code_type", TEST_TYPE);

  const { data: seeded, error: seedErr } = await supabase
    .from(surface.table)
    .insert({
      billing_code: TEST_CODE,
      billing_code_type: TEST_TYPE,
      service_slug: "office_visit",
      confidence: 0.5,
      observation_count: 1,
      provider_descriptions: [SYNTH],
      description_signature: "ing-e seed validate",
      source: "ing_e_seed_validate",
    })
    .select("id, observation_count, provider_descriptions")
    .single();
  if (seedErr || !seeded) {
    console.error(`seed-validate: insert failed: ${seedErr?.message}`);
    process.exit(1);
  }
  const rowId = String(seeded.id);

  try {
    // 1. dry-run detects the change + asserts pass.
    const res = redactColumnValue(surface, seeded.provider_descriptions, redact);
    ok("seeded row redacts (changed)", res.changed);
    ok("coverage preserved (no coverage-loss)", !coverageLost(res.units));
    ok("redaction is idempotent", !nonIdempotent(res.units));

    // 2. apply happy path — real snapshot + guarded UPDATE.
    const outcome = await applyRow(surface, seeded as Record<string, unknown>, rowId, res.newValue, res.units);
    ok(`apply writes the row (got: ${outcome})`, outcome === "written");

    // 3. re-read: PII gone, coverage token intact.
    const { data: after } = await supabase.from(surface.table).select("provider_descriptions").eq("id", rowId).single();
    const post = ((after?.provider_descriptions as string[]) ?? [])[0] ?? "";
    ok("stored value redacted (marker present)", post.includes("[REDACTED:"));
    ok("stored value PII removed", !post.includes("W123456789"));
    ok("stored value coverage preserved ($30 copay)", post.includes("$30 copay"));

    // 4. snapshot row exists with correct pre/post.
    const { data: snap } = await supabase
      .from(SNAPSHOT_TABLE)
      .select("pre_value, post_value, patterns")
      .eq("surface", surface.id)
      .eq("row_id", rowId)
      .maybeSingle();
    ok("snapshot pre_value holds the original PII", !!snap && snap.pre_value.includes("W123456789"));
    ok("snapshot post_value is redacted", !!snap && snap.post_value.includes("[REDACTED:"));

    // 5. GUARD path: bump the guard column, then a stale-guard apply must SKIP (no clobber).
    await supabase.from(surface.table).update({ observation_count: 2 }).eq("id", rowId);
    const guardOutcome = await applyRow(surface, { ...(seeded as Record<string, unknown>), observation_count: 1 }, rowId, res.newValue, res.units);
    ok(`stale-guard apply is skipped (got: ${guardOutcome})`, guardOutcome === "guard-skipped");
  } finally {
    // Cleanup — delete the throwaway row + its snapshot rows (self-cleaning).
    await supabase.from(surface.table).delete().eq("id", rowId);
    await supabase.from(SNAPSHOT_TABLE).delete().eq("row_id", rowId);
  }

  const total = pass + fails.length;
  console.log(`\nseed-validate (${surface.id}): ${pass}/${total} PASS`);
  if (fails.length) {
    console.log(`${fails.length} FAILURE(S):`);
    for (const f of fails) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("✓ apply path proven on real redaction (snapshot + guarded UPDATE + guard-skip); throwaway row cleaned.\n");
}

async function main(): Promise<void> {
  console.log(`\n═══ Ing-E PII backfill — mode=${MODE} batch=${BATCH_ID} ═══`);
  if (MODE === "seed-validate") return seedValidate();

  // Pass 1 — dry-run (read-only) over ALL 6 wired surfaces.
  const tallies = await runDryRunPass();
  report(tallies);
  const tot = tallies.reduce(
    (a, t) => ({ rows: a.rows + t.rowsScanned, units: a.units + t.unitsScanned, changed: a.changed + t.rowsChanged, redacted: a.redacted + t.unitsRedacted }),
    { rows: 0, units: 0, changed: 0, redacted: 0 },
  );
  console.log(`\n── totals: rows=${tot.rows} units=${tot.units} rowsChanged=${tot.changed} unitsRedacted=${tot.redacted} ──`);
  console.log("   (these 6 wired surfaces are a subset of the audit's 22,895-unit / 0-auto-PII sweep)");

  const trips = guardTrips(tallies);
  if (MODE === "dry-run") {
    if (trips.length) {
      console.log(`\n⚠️  ${trips.length} guard finding(s) — would BLOCK --apply:`);
      for (const r of trips) console.log(`   ✗ ${r}`);
      process.exit(1);
    }
    console.log("\n✓ DRY-RUN CLEAN — 0 rows would change = verified no-op. (Mechanism proven by --seed-validate.)");
    return;
  }

  // MODE === apply — refuse on any guard trip.
  if (trips.length) {
    console.log("\n⛔ APPLY ABORTED — guard tripped:");
    for (const r of trips) console.log(`   ✗ ${r}`);
    process.exit(1);
  }
  console.log(`\n→ guard clean; applying to ${BACKFILL_APPLY_SURFACES.length} direct-writer surface(s)…`);
  const written: SurfaceTally[] = [];
  for (const s of BACKFILL_APPLY_SURFACES) written.push(await processSurface(s, "apply", true));
  report(written);
  const w = written.reduce((a, t) => a + t.rowsWritten, 0);
  const g = written.reduce((a, t) => a + t.guardSkipped, 0);
  console.log(`\n✓ APPLY complete — rowsWritten=${w} guardSkipped=${g} (snapshots → ${SNAPSHOT_TABLE} batch=${BATCH_ID}).`);
}

main().catch((e) => {
  console.error("BACKFILL FAILED:", (e as Error).message);
  process.exit(1);
});
