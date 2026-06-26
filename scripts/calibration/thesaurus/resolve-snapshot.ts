/**
 * Service Thesaurus harness — SNAPSHOT PRODUCER.
 *
 * ⚠️ RUN VIA SONNET, IN A SEPARATE SESSION — never Opus, never inline in the design session.
 *    This step COSTS Haiku (the resolver forward pass) and hits the DB. Its output is
 *    frozen JSON that the DETERMINISTIC scorer (run.ts) consumes with zero further spend.
 *
 * Produces, for one phase:
 *   - forward.json          ForwardMapEntry[]   (N-run MAJORITY consensus over the resolver runs)
 *   - forward.runs.json     ForwardMapEntry[][] (the N raw runs — freeze for zero-respend re-derive)
 *   - convergence.json      ConvergenceReport   (per-entry agreement + the gate's stability statement)
 *   - stored.json           StoredCanonical[]   (current canonical_plan_services slugs per GT canonical)
 *   - cohorts-snapshot.json CohortSnapshot[]    (real resolveCanonicalPlan over the 20 cohorts)
 *   - b5-current.json       B5Counts            (per-slug inbound row tally — over-collapse tripwire)
 *
 * N-run majority (S170): the resolver calls Haiku at temp=0 (locked single-temperature regime), so
 * run-to-run variance is RESIDUAL nondeterminism. N forward passes + per-gtId majority vote de-noise
 * it; convergence.json proves the result is stable (or surfaces the flippy entries). N via env N_RUNS
 * (default 5; the gate run uses 9).
 *
 * Run (Sonnet session):
 *   unset HAIKU_SNAPSHOT_REPLAY HAIKU_SNAPSHOT_RECORD   # else the N runs collapse to one cached response
 *   N_RUNS=9 npx tsx scripts/calibration/thesaurus/resolve-snapshot.ts <gt.json> <cohorts.json> <out-dir>
 */
import { join } from "path";
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { resolveServices, loadCatalogRich, loadResolverConfig, type ResolveLineInput, type ServiceResolution } from "@/lib/claims/service-resolver";
import { resolveCanonicalPlan } from "@/lib/plan/compare";
import { loadCalibEnv } from "../../lib/calib-env";
import { loadGt } from "./gt-loader";
import { loadCohortDefs } from "./cohorts";
import { scoredResolvedFraction, RESOLVED_FRACTION_FLOOR } from "./score";
import type { ForwardMapEntry, StoredCanonical, CohortSnapshot, B5Counts, ConvergenceReport } from "./types";

// S170 hardening B: loadCalibEnv walks up for .env.local + override:true (a stale/EMPTY shell var — Claude
// Code pre-sets ANTHROPIC_API_KEY="" — cannot win) + validates every required cred is present AND non-empty,
// throwing loudly otherwise. Replaces the ad-hoc no-override config({cwd}) that silently degraded the run.
const env = loadCalibEnv(["CALIB_USER_ID"]);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
// Calibration runs attribute Haiku spend to a system user (spend-cap bookkeeping).
const CALIB_USER_ID = env.CALIB_USER_ID;

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

  // ── HARD PRECONDITIONS (S170) — fail BEFORE spending ~N×44 Haiku calls ──
  // (1) The disk snapshot cache (haiku-client/base.ts) keys on (systemPrompt+userContent+sectionLabel)
  //     with NO run index, so REPLAY returns run-1's saved response for every run → a falsely-unanimous
  //     gate. Refuse to run under replay.
  if (process.env.HAIKU_SNAPSHOT_REPLAY === "true")
    throw new Error("HAIKU_SNAPSHOT_REPLAY=true collapses the N-run majority to one cached response — unset it before calibrating.");
  if (process.env.HAIKU_SNAPSHOT_RECORD === "true")
    console.warn("⚠ HAIKU_SNAPSHOT_RECORD=true — the live API is still hit each run (variance preserved); snapshots just get overwritten. Safe to ignore, or unset.");
  const N = Math.max(1, Number(process.env.N_RUNS ?? 5));
  console.log(`N_RUNS = ${N} (majority consensus over ${N} temp-0 forward passes)`);

  const catalog = await loadCatalogRich(supabase);
  // (2) Prove we're on the post-mig-152 catalog: hospital_outpatient must have dropped out of the
  //     candidate set (loadCatalogRich deprecated_at filter). Still present ⇒ stale catalog/env ⇒ invalid run.
  if (catalog.some((c) => c.slug === "hospital_outpatient"))
    throw new Error("hospital_outpatient still in the resolver candidate set — mig 152 not reflected (stale catalog/env). Aborting before spend.");

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
  // canon: collapse a deprecated/merged slug to its live identity (idempotent on live slugs); voting
  // on canon(slug) keeps a rename pair (e.g. generic_rx_tier1 / generic_rx) from splitting the majority.
  const canon = (s: string | null): string | null => (s == null ? null : (renameMap[s] ?? s));

  // ── forward: resolver over every GT service, N TIMES → majority consensus (S170) ──
  // CHUNK: resolveServices builds ONE Haiku prompt over all unresolved lines — sending the full
  // GT (~thousands of lines) in one call would truncate. Resolve in batches; skipWriteback so the
  // calibration never teaches the resolver from the test set or mutates the PROD learned cache.
  const lines: ResolveLineInput[] = gt.map((g, i) => ({ lineNumber: i, description: g.serviceName }));
  const CHUNK = 60;

  async function runForwardOnce(runIdx: number): Promise<ForwardMapEntry[]> {
    const resMap = new Map<number, ServiceResolution>();
    for (let i = 0; i < lines.length; i += CHUNK) {
      // strict:true (S170 hardening C, wired in B): a Haiku-tier failure (error / spend-cap pause) RE-THROWS
      // instead of degrading the calibration to all-null. A degraded resolution must never masquerade as a result.
      // A2b Phase 2: emitModifiers measures place/component/multi-label WITHOUT trustTieredCache → slug tiers
      // untouched → slug-level byte-identical. Modifiers are description-derived (deterministic, no Haiku).
      const m = await resolveServices(lines.slice(i, i + CHUNK), { supabase, userId: CALIB_USER_ID, config: cfg, catalog, skipWriteback: true, strict: true, emitModifiers: true });
      for (const [k, v] of m) resMap.set(k, v);
      console.log(`  run ${runIdx + 1}/${N}: resolved ${Math.min(i + CHUNK, lines.length)}/${lines.length}`);
    }
    return gt.map((g, i) => {
      const r = resMap.get(i);
      return { gtId: g.id, resolvedSlug: r?.slug ?? null, conceptId: r?.conceptId ?? null, confidence: r?.confidence ?? 0, source: r?.source ?? "none", needsReview: r?.needsReview ?? true, placeOfService: r?.placeOfService, component: r?.component, multiLabel: r?.multiLabel, isPreventiveEligible: r?.isPreventiveEligible, planTierLabel: r?.planTierLabel };
    });
  }

  const runs: ForwardMapEntry[][] = [];
  for (let r = 0; r < N; r++) runs.push(await runForwardOnce(r));
  writeFileSync(join(outDir, "forward.runs.json"), JSON.stringify(runs, null, 2));
  console.log(`forward.runs.json: ${N} run(s) frozen (re-derive the majority + score with zero re-spend)`);

  // ── majority vote per gtId on canon(slug). Winner = plurality → higher summed confidence (the null
  // bucket sums ~0 confidence, so a real slug wins a count-tie vs null → hard cases stay in the precision
  // denominator, NO abstain-inflation) → lexicographic (deterministic). ──
  const NULL_KEY = "￿__null__"; // sentinel sorts AFTER real slugs → a real slug wins a full tie (mapped, not abstained)
  const gtById = new Map(gt.map((g) => [g.id, g]));
  let tieBroken = 0;
  const forward: ForwardMapEntry[] = gt.map((g, i) => {
    const perRun = runs.map((run) => run[i]); // N entries for this gtId (aligned by index)
    const votes = new Map<string, { count: number; confSum: number; rep: ForwardMapEntry }>();
    for (const e of perRun) {
      const key = e.resolvedSlug == null ? NULL_KEY : (canon(e.resolvedSlug) as string);
      const v = votes.get(key) ?? { count: 0, confSum: 0, rep: e };
      v.count += 1; v.confSum += e.confidence;
      votes.set(key, v);
    }
    const ranked = [...votes.entries()].sort((a, b) =>
      b[1].count - a[1].count || b[1].confSum - a[1].confSum || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const [winKey, win] = ranked[0];
    if (ranked.length > 1 && ranked[1][1].count === win.count) tieBroken += 1;
    return {
      gtId: g.id,
      resolvedSlug: winKey === NULL_KEY ? null : winKey,
      conceptId: win.rep.conceptId,
      confidence: win.count ? win.confSum / win.count : 0,
      source: win.rep.source,
      needsReview: win.rep.needsReview,
      agreement: win.count / N,
      // A2b Phase 2: modifiers are description-derived → identical across all N runs → take from any (perRun[0]).
      placeOfService: perRun[0]?.placeOfService,
      component: perRun[0]?.component,
      multiLabel: perRun[0]?.multiLabel,
      isPreventiveEligible: perRun[0]?.isPreventiveEligible,
      planTierLabel: perRun[0]?.planTierLabel,
    };
  });
  // ── output-validity gate (S170 hardening B): refuse to FREEZE a degenerate snapshot. `strict` already
  // re-throws a THROWING Haiku failure (empty key, API error, spend-pause); this is the independent OUTPUT
  // invariant — it catches the residual non-erroring all-null Haiku response too (a forward.json that would
  // score a fake precision on a collapsed denominator). ──
  const { fraction, scoredN, scoredResolved } = scoredResolvedFraction(gt, forward);
  if (scoredN > 0 && fraction < RESOLVED_FRACTION_FLOOR)
    throw new Error(
      `output-validity: only ${scoredResolved}/${scoredN} (${(fraction * 100).toFixed(1)}%) of scored GT resolved — below the ` +
        `${(RESOLVED_FRACTION_FLOOR * 100).toFixed(0)}% floor. Degenerate run (Haiku tier failed/empty); refusing to freeze a ` +
        `snapshot that would score a fake precision on a collapsed denominator.`,
    );

  writeFileSync(join(outDir, "forward.json"), JSON.stringify(forward, null, 2));
  console.log(`forward.json: ${forward.length} entries (${forward.filter((f) => f.resolvedSlug).length} resolved) · majority of ${N}`);

  // ── convergence report (S170): the gate's stability statement. Over scored entries (all) AND the
  // andrew-B2 subset separately (the andrew subset is what the gate precision uses). ──
  const histAll: Record<number, number> = {};
  const histAndrew: Record<number, number> = {};
  let unstableAll = 0, unstableAndrew = 0, fragileAll = 0, fragileAndrew = 0, sumAll = 0, nAll = 0, sumAndrew = 0, nAndrew = 0;
  const fragileAndrewSample: ConvergenceReport["fragileAndrewSample"] = [];
  forward.forEach((f, i) => {
    const g = gtById.get(f.gtId)!;
    const scored = !g.notFound && g.correctSlug !== null;
    const andrew = g.adjudicationStatus === "andrew" && !g.notFound;
    if (!scored && !andrew) return;
    const tally = new Map<string, number>();
    for (const e of runs.map((run) => run[i])) {
      const k = e.resolvedSlug == null ? NULL_KEY : (canon(e.resolvedSlug) as string);
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    const counts = [...tally.values()].sort((a, b) => b - a);
    const winCount = counts[0];
    const fragile = winCount - (counts[1] ?? 0) <= 1;
    if (scored) {
      histAll[winCount] = (histAll[winCount] ?? 0) + 1;
      if ((f.agreement ?? 1) < 1) unstableAll += 1;
      if (fragile) fragileAll += 1;
      sumAll += f.agreement ?? 1; nAll += 1;
    }
    if (andrew) {
      histAndrew[winCount] = (histAndrew[winCount] ?? 0) + 1;
      if ((f.agreement ?? 1) < 1) unstableAndrew += 1;
      if (fragile) {
        fragileAndrew += 1;
        if (fragileAndrewSample.length < 15)
          fragileAndrewSample.push({ gtId: f.gtId, serviceName: g.serviceName, winner: f.resolvedSlug, votes: Object.fromEntries([...tally].map(([k, v]) => [k === NULL_KEY ? "∅" : k, v])) });
      }
      sumAndrew += f.agreement ?? 1; nAndrew += 1;
    }
  });
  const convergence: ConvergenceReport = {
    nRuns: N, histogramAll: histAll, histogramAndrew: histAndrew,
    unstableAll, unstableAndrew, fragileAll, fragileAndrew, tieBroken,
    meanAgreementAll: nAll ? sumAll / nAll : 1, meanAgreementAndrew: nAndrew ? sumAndrew / nAndrew : 1,
    fragileAndrewSample,
  };
  writeFileSync(join(outDir, "convergence.json"), JSON.stringify(convergence, null, 2));
  console.log(`convergence.json: andrew mean-agreement ${(convergence.meanAgreementAndrew * 100).toFixed(1)}% · ${unstableAndrew} unstable · ${fragileAndrew} fragile(margin≤1) · ${tieBroken} tie-broken`);

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
