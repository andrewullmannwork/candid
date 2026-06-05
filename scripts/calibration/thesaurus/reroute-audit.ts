/**
 * S170 reroute-audit — prove mig 152's efficacy. The services the BASELINE resolver mapped to
 * `hospital_outpatient` must re-route now that the slug is retired (deprecated_at → dropped from the
 * candidate set). Pure JSON diff (no DB, no Haiku) over two frozen forward snapshots.
 *
 * Proof bar: (1) the NEW consensus has ZERO entries resolving to hospital_outpatient (overall invariant);
 *            (2) the targeted services re-route — the bulk to `surgery` — and how many now score correct.
 *
 * Correctness is RENAME-AWARE (same as score.ts): the oracle's correctSlug is often an OLD merged slug
 * (e.g. outpatient_surgery_facility) whose live identity is `surgery`; canon() collapses both sides via
 * the rename-map before comparing, so resolve-to-`surgery` counts correct against correct=outpatient_surgery_facility.
 *
 * Run: npx tsx scripts/calibration/thesaurus/reroute-audit.ts <baseline-forward.json> <new-forward.json> <gt.json> [rename-map.json]
 *   rename-map.json defaults to the file beside <new-forward.json> (emitted by resolve-snapshot.ts).
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { loadGt } from "./gt-loader";
import type { ForwardMapEntry } from "./types";

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const TARGET = "hospital_outpatient";

function main() {
  const [basePath, newPath, gtPath, rmArg] = process.argv.slice(2);
  if (!basePath || !newPath || !gtPath)
    throw new Error("usage: reroute-audit.ts <baseline-forward.json> <new-forward.json> <gt.json> [rename-map.json]");
  const base = readJson<ForwardMapEntry[]>(basePath);
  const next = readJson<ForwardMapEntry[]>(newPath);
  const { gt } = loadGt(gtPath); // normalizes bare-array | {services:[…]} + validates (same as the rest of the harness)
  const gtById = new Map(gt.map((g) => [g.id, g]));
  const nextById = new Map(next.map((f) => [f.gtId, f]));

  // canon (rename-aware, exactly like score.ts): collapse a merged/renamed slug to its live identity so
  // a resolve-to-`surgery` matches an oracle correctSlug of `outpatient_surgery_facility` (merged → surgery).
  const rmPath = rmArg ?? join(dirname(newPath), "rename-map.json");
  const renameMap: Record<string, string> = existsSync(rmPath) ? readJson<Record<string, string>>(rmPath) : {};
  if (!Object.keys(renameMap).length)
    console.warn(`⚠ rename-map.json not found at ${rmPath} — comparing RAW slugs; renames (e.g. outpatient_surgery_facility→surgery) will read as mismatches.`);
  const canon = (s: string | null): string | null => (s == null ? null : (renameMap[s] ?? s));

  const targeted = base.filter((f) => f.resolvedSlug === TARGET);
  const stillThere = next.filter((f) => f.resolvedSlug === TARGET); // overall invariant: MUST be 0 (raw resolver slug)

  const dest: Record<string, number> = {};
  const destCorrect: Record<string, number> = {};
  const rows: string[] = [];
  let nowCorrect = 0;
  for (const b of targeted) {
    const g = gtById.get(b.gtId);
    const toRaw = nextById.get(b.gtId)?.resolvedSlug ?? null;
    const to = toRaw ?? "∅";
    const correct = g?.correctSlug ?? null;
    const acceptable = g?.acceptableSlugs ?? [];
    const ok = toRaw != null && (canon(toRaw) === canon(correct) || acceptable.some((a) => canon(a) === canon(toRaw)));
    dest[to] = (dest[to] ?? 0) + 1;
    if (ok) { nowCorrect += 1; destCorrect[to] = (destCorrect[to] ?? 0) + 1; }
    const toAnno = toRaw && canon(toRaw) !== toRaw ? ` (=${canon(toRaw)})` : "";
    const correctAnno = correct && canon(correct) !== correct ? ` =${canon(correct)}` : "";
    rows.push(`  ${b.gtId} "${g?.serviceName ?? "?"}" → ${to}${toAnno}  (correct: ${correct ?? "∅"}${correctAnno}${acceptable.length ? ` | ok-alts: ${acceptable.join(",")}` : ""})${ok ? "  ✓" : ""}`);
  }

  console.log(`# mig 152 reroute audit\n`);
  console.log(`baseline → ${TARGET}: ${targeted.length} services`);
  console.log(`new → ${TARGET} (overall invariant, MUST be 0): ${stillThere.length} ${stillThere.length === 0 ? "✓" : "✗ FAIL"}`);
  console.log(`of the ${targeted.length}: now scoring correct (rename-aware correctSlug or acceptable): ${nowCorrect}\n`);
  console.log(`new destinations (raw resolver slug):`);
  for (const [slug, n] of Object.entries(dest).sort((a, b) => b[1] - a[1]))
    console.log(`  ${slug}: ${n}${destCorrect[slug] ? ` (${destCorrect[slug]} correct)` : ""}`);
  console.log(`\nper-service:`);
  console.log(rows.join("\n"));

  if (stillThere.length > 0) {
    console.error(`\n✗ ${TARGET} still resolved in the new snapshot — mig 152 not effective here.`);
    process.exit(2);
  }
}
main();
