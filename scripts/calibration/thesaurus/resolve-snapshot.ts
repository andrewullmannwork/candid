/**
 * Service Thesaurus harness — SNAPSHOT PRODUCER.
 *
 * ⚠️ RUN VIA SONNET, IN A SEPARATE SESSION — never Opus, never inline in the design session.
 *    This step COSTS Haiku (the resolver forward pass) and hits the DB. Its output is
 *    frozen JSON that the DETERMINISTIC scorer (run.ts) consumes with zero further spend.
 *
 * Produces, for one phase:
 *   - forward.json          ForwardMapEntry[]  (resolver run over every GT service)
 *   - stored.json           StoredCanonical[]  (current canonical_plan_services slugs per GT canonical)
 *   - cohorts-snapshot.json CohortSnapshot[]   (real resolveCanonicalPlan over the 20 cohorts)
 *   - b5-current.json       B5Counts           (per-slug inbound row tally — over-collapse tripwire)
 *
 * Run (Sonnet session):
 *   npx tsx scripts/calibration/thesaurus/resolve-snapshot.ts <gt.json> <cohorts.json> <out-dir>
 */
import { config } from "dotenv";
import { resolve, join } from "path";
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { resolveServices, loadCatalogRich, loadResolverConfig, type ResolveLineInput, type ServiceResolution } from "@/lib/claims/service-resolver";
import { resolveCanonicalPlan } from "@/lib/plan/compare";
import { loadGt } from "./gt-loader";
import { loadCohortDefs } from "./cohorts";
import type { ForwardMapEntry, StoredCanonical, CohortSnapshot, B5Counts } from "./types";

config({ path: resolve(process.cwd(), ".env.local") });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false } });
// Calibration runs attribute Haiku spend to a system user (spend-cap bookkeeping).
const CALIB_USER_ID = process.env.CALIB_USER_ID as string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase PostgrestFilterBuilder generic is impractical to thread through a tiny calibration helper
async function fetchAll<T = Record<string, unknown>>(table: string, columns: string, mod?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(columns).range(from, from + 999);
    if (mod) q = mod(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  const [gtPath, cohortsPath, outDir] = process.argv.slice(2);
  if (!gtPath || !cohortsPath || !outDir) throw new Error("usage: resolve-snapshot.ts <gt.json> <cohorts.json> <out-dir>");
  const catalog = await loadCatalogRich(supabase);
  const cfg = await loadResolverConfig(supabase);
  const { gt, warnings } = loadGt(gtPath, new Set(catalog.map((c) => c.slug)));
  if (warnings.length) console.warn(`GT warnings:\n  ${warnings.join("\n  ")}`);

  // ── rename-map.json: deprecated slug -> final live target (follow merged_into_id chains).
  // DERIVED from the live catalog (data-driven, NOT hardcoded) so the deterministic scorer can
  // canonicalize the oracle's OLD slugs (e.g. generic_rx_tier1) to the NEW vocabulary (generic_rx)
  // before comparing — without this, every renamed slug reads as a false regression. Self-maintaining
  // as deprecations grow (Pattern S merge pattern = merged_into_id is the authoritative identity link).
  const allCat = await fetchAll<{ id: string; slug: string; merged_into_id: string | null }>("service_catalog", "id, slug, merged_into_id");
  const catById = new Map(allCat.map((c) => [c.id, c]));
  const renameMap: Record<string, string> = {};
  for (const c of allCat) {
    if (!c.merged_into_id) continue;
    let cur = catById.get(c.merged_into_id);
    const seen = new Set<string>([c.id]);
    while (cur?.merged_into_id && !seen.has(cur.id)) { seen.add(cur.id); cur = catById.get(cur.merged_into_id); }
    if (cur) renameMap[c.slug] = cur.slug;
  }
  writeFileSync(join(outDir, "rename-map.json"), JSON.stringify(renameMap, null, 2));
  console.log(`rename-map.json: ${Object.keys(renameMap).length} deprecated->target entries`);

  // ── forward: resolver over every GT service (description = source prose; no code on plan-docs) ──
  // CHUNK: resolveServices builds ONE Haiku prompt over all unresolved lines — sending the full
  // GT (~thousands of lines) in one call would truncate. Resolve in batches; skipWriteback so the
  // calibration never teaches the resolver from the test set or mutates the PROD learned cache.
  const lines: ResolveLineInput[] = gt.map((g, i) => ({ lineNumber: i, description: g.serviceName }));
  const CHUNK = 60;
  const resMap = new Map<number, ServiceResolution>();
  for (let i = 0; i < lines.length; i += CHUNK) {
    const m = await resolveServices(lines.slice(i, i + CHUNK), { supabase, userId: CALIB_USER_ID, config: cfg, catalog, skipWriteback: true });
    for (const [k, v] of m) resMap.set(k, v);
    console.log(`  forward resolved ${Math.min(i + CHUNK, lines.length)}/${lines.length}`);
  }
  const forward: ForwardMapEntry[] = gt.map((g, i) => {
    const r = resMap.get(i);
    return { gtId: g.id, resolvedSlug: r?.slug ?? null, conceptId: r?.conceptId ?? null, confidence: r?.confidence ?? 0, source: r?.source ?? "none", needsReview: r?.needsReview ?? true };
  });
  writeFileSync(join(outDir, "forward.json"), JSON.stringify(forward, null, 2));
  console.log(`forward.json: ${forward.length} entries (${forward.filter((f) => f.resolvedSlug).length} resolved)`);

  // ── stored: current canonical_plan_services slugs per GT canonical ──
  const canonicalIds = [...new Set(gt.map((g) => g.canonicalPlanId).filter(Boolean) as string[])];
  const stored: StoredCanonical[] = [];
  for (const cid of canonicalIds) {
    const rows = await fetchAll<{ service_slug: string | null }>("canonical_plan_services", "service_slug", (q) => q.eq("canonical_plan_id", cid));
    stored.push({ canonicalPlanId: cid, slugs: [...new Set(rows.map((r) => r.service_slug).filter(Boolean) as string[])] });
  }
  writeFileSync(join(outDir, "stored.json"), JSON.stringify(stored, null, 2));

  // ── cohorts: REAL resolveCanonicalPlan per plan (coveredSlugs = benefits.serviceSlug) ──
  const cohortDefs = loadCohortDefs(cohortsPath);
  const cohortSnaps: CohortSnapshot[] = [];
  for (const c of cohortDefs) {
    const plans: CohortSnapshot["plans"] = [];
    for (const cid of c.canonicalPlanIds) {
      const payload = await resolveCanonicalPlan({ supabase, canonicalPlanId: cid, decoration: null });
      const covered = [...new Set((payload?.benefits ?? []).map((b) => b.serviceSlug))];
      // inferredSlugs: backstop-synthesized benefits. Baseline (no backstop) = []. When the
      // #1/#3 backstop is integrated, read the inferred flag off the benefit here.
      const inferred = [...new Set((payload?.benefits ?? []).filter((b) => (b as { inferred?: boolean }).inferred).map((b) => b.serviceSlug))];
      plans.push({ canonicalPlanId: cid, planName: payload?.planName ?? cid, insurer: payload?.insurerName ?? "", coveredSlugs: covered, inferredSlugs: inferred });
    }
    cohortSnaps.push({ cohortId: c.cohortId, plans });
  }
  writeFileSync(join(outDir, "cohorts-snapshot.json"), JSON.stringify(cohortSnaps, null, 2));

  // ── B5: per-slug inbound tally across canonical_plan_services ──
  const allCps = await fetchAll<{ service_slug: string | null }>("canonical_plan_services", "service_slug");
  const b5: B5Counts = {};
  for (const r of allCps) { const s = r.service_slug; if (s) b5[s] = (b5[s] ?? 0) + 1; }
  writeFileSync(join(outDir, "b5-current.json"), JSON.stringify(b5, null, 2));

  console.log(`snapshots written to ${outDir}`);
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
