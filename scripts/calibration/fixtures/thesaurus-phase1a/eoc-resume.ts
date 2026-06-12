/**
 * S195 EOC-RESUME fixture (no DB, no Haiku).
 *
 *   npx tsx scripts/calibration/fixtures/thesaurus-phase1a/eoc-resume.ts
 *
 * Proves the pure layer of the checkpointed EOC parse (eoc-resume.ts):
 *   1. Scheduler truth table (`planNextEocWork`): fresh state runs units in
 *      order; done units skipped; the three money-fire guards each fail loudly
 *      (per-unit attempt cap / invocation cap / cumulative cost rail); all
 *      units done → assemble.
 *   2. Fragment assembly (`mergeEocFragments`): per-unit fragments recompose
 *      into one EOCParseResult — identity/aca placement, sections spread-merge,
 *      summed totals, recomposed timings, slice-marker warnings stripped, real
 *      warnings + parse_errors kept, dispatched_sections unioned,
 *      column_wrap_decision from the MN unit.
 *   3. Heartbeat freshness (duplicate-delivery guard) + unit slice options
 *      (every unit skips the legs it doesn't own; MN carries the prose-PA leg).
 */
import {
  EOC_RESUME_UNITS,
  initEocParseState,
  planNextEocWork,
  mergeEocFragments,
  unitParseOptions,
  runnableUnits,
  heartbeatIsFresh,
  shouldSkipAsDuplicateDelivery,
  hasPendingUnits,
  cumulativeCostUsd,
  buildEocParseRunlog,
  type EocParseState,
  type EocResumeCaps,
} from "@/lib/plan/eoc-resume";
import { buildEocParseSlackText, resolveEocSlackChannelId } from "@/lib/plan/eoc-parse-slack";
import type { EOCParseResult } from "@/lib/eoc/types";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.error(`  FAIL  ${name}`);
  }
}

const CAPS: EocResumeCaps = { unitAttemptCap: 2, maxInvocations: 8, maxCostUsd: 1.0 };
const NOW = "2026-06-11T23:30:00.000Z";

function freshState(): EocParseState {
  const s = initEocParseState(NOW, true, "doc:test");
  s.invocations = 1;
  return s;
}

function frag(over: Partial<EOCParseResult>): EOCParseResult {
  return {
    plan_identity: {
      insurer_name: null,
      plan_name: null,
      plan_year: null,
      in_deductible_individual: null,
      in_oop_max_individual: null,
      out_deductible_individual: null,
      out_oop_max_individual: null,
    },
    aca_compliance: null,
    sections: {},
    total_cost_usd: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_create_tokens: 0,
    total_cache_read_tokens: 0,
    timings: { plan_identity_ms: 0, aca_ms: 0, sections_ms: 0, total_ms: 0 },
    segmentation_used: "regex_only",
    warnings: [],
    parse_errors: [],
    dispatched_sections: [],
    ...over,
  } as EOCParseResult;
}

// ── PART 1 — scheduler truth table ───────────────────────────────────────────
console.log("PART 1 — planNextEocWork:");
{
  const s = freshState();
  const n = planNextEocWork(s, CAPS);
  check(
    "fresh state → run plan_identity (first unit)",
    n.action === "run" && n.unit === "plan_identity",
  );
}
{
  const s = freshState();
  s.units.plan_identity = { status: "done", attempts: 1, cost_usd: 0.01, ms: 5000 };
  const n = planNextEocWork(s, CAPS);
  check("done units skipped → run aca next", n.action === "run" && n.unit === "aca");
}
{
  const s = freshState();
  for (const u of EOC_RESUME_UNITS) s.units[u] = { status: "done", attempts: 1, cost_usd: 0.05, ms: 1 };
  check("all done → assemble", planNextEocWork(s, CAPS).action === "assemble");
  check("hasPendingUnits false when all done", !hasPendingUnits(s));
}
{
  const s = freshState();
  s.units.plan_identity.attempts = 2; // started twice, never completed
  const n = planNextEocWork(s, CAPS);
  check(
    "unit attempt cap → fail naming the unit",
    n.action === "fail" && n.reason.includes("unit_attempt_cap:plan_identity"),
  );
}
{
  const s = freshState();
  s.invocations = 9;
  const n = planNextEocWork(s, CAPS);
  check("invocation cap (units pending) → fail", n.action === "fail" && n.reason.includes("invocation_cap"));
}
{
  // S195 night-1 lesson: caps bound UNIT work only. With all units done, every
  // Haiku dollar is banked — assemble must proceed at ANY counter/cost reading
  // (the observed failure: clobber-bumped invocations hit the cap at 6/6 and
  // threw away a complete parse as "We had an issue with your upload").
  const s = freshState();
  for (const u of EOC_RESUME_UNITS) s.units[u] = { status: "done", attempts: 2, cost_usd: 0.4, ms: 1 };
  s.invocations = 99;
  const n = planNextEocWork(s, CAPS);
  check("ASSEMBLE EXEMPT FROM CAPS: all-done + inv=99 + cost>$1 → assemble (never fail)", n.action === "assemble");
}
{
  const s = freshState();
  s.units.plan_identity = { status: "done", attempts: 1, cost_usd: 0.7, ms: 1 };
  s.units.aca = { status: "done", attempts: 1, cost_usd: 0.4, ms: 1 };
  const n = planNextEocWork(s, CAPS);
  check(
    "cumulative cost rail ($1.10 > $1.00) → fail BEFORE next unit starts",
    n.action === "fail" && n.reason.includes("cost_cap"),
  );
  check("cumulativeCostUsd sums per-unit spend", Math.abs(cumulativeCostUsd(s) - 1.1) < 1e-9);
}

// ── PART 2 — fragment assembly ───────────────────────────────────────────────
console.log("\nPART 2 — mergeEocFragments:");
{
  const identity = frag({
    plan_identity: {
      insurer_name: "Blue Shield of California",
      plan_name: "Silver 73 PPO",
      plan_year: 2026,
      in_deductible_individual: 5400,
      in_oop_max_individual: 8700,
      out_deductible_individual: null,
      out_oop_max_individual: null,
    },
    total_cost_usd: 0.02,
    timings: { plan_identity_ms: 9000, aca_ms: 0, sections_ms: 0, total_ms: 9500 },
    warnings: ["eoc_aca_skipped_by_option", "eoc_section_skipped_by_filter:medical_necessity"],
  });
  const aca = frag({
    aca_compliance: {
      data: { isAcaCompliant: true, acaComplianceBasis: "marketplace", source_excerpt: "x" },
    } as unknown as EOCParseResult["aca_compliance"],
    total_cost_usd: 0.01,
    timings: { plan_identity_ms: 0, aca_ms: 4000, sections_ms: 0, total_ms: 4200 },
    warnings: ["plan_identity_skipped_by_option:doc"],
  });
  const mn = frag({
    sections: { medical_necessity: { data: { criteria: [1, 2, 3] } } as never },
    total_cost_usd: 0.30,
    total_input_tokens: 1000,
    total_output_tokens: 500,
    total_cache_create_tokens: 50,
    total_cache_read_tokens: 800,
    timings: { plan_identity_ms: 0, aca_ms: 0, sections_ms: 200_000, total_ms: 201_000 },
    warnings: ["real_warning_keep_me", "plan_identity_skipped_by_option:doc"],
    parse_errors: [{ section: "medical_necessity", error: "partial" }] as EOCParseResult["parse_errors"],
    dispatched_sections: ["medical_necessity"],
    column_wrap_decision: { score: 0.4, fired: false } as never,
  });
  const pa = frag({
    sections: { prior_auth_codes: { data: { codes: [] } } as never },
    total_cost_usd: 0.10,
    timings: { plan_identity_ms: 0, aca_ms: 0, sections_ms: 60_000, total_ms: 61_000 },
    dispatched_sections: ["prior_auth_codes"],
  });
  const merged = mergeEocFragments({
    plan_identity: identity,
    aca,
    medical_necessity: mn,
    prior_auth_codes: pa,
  });
  check("identity from its unit", merged.plan_identity.insurer_name === "Blue Shield of California");
  check("aca from its unit", merged.aca_compliance !== null);
  check(
    "sections spread-merged",
    !!merged.sections.medical_necessity && !!merged.sections.prior_auth_codes,
  );
  check("cost summed", Math.abs(merged.total_cost_usd - 0.43) < 1e-9);
  check("token totals summed", merged.total_input_tokens === 1000 && merged.total_cache_read_tokens === 800);
  check(
    "timings recomposed (identity ms from identity unit, sections summed, total summed)",
    merged.timings.plan_identity_ms === 9000 &&
      merged.timings.aca_ms === 4000 &&
      merged.timings.sections_ms === 260_000 &&
      merged.timings.total_ms === 275_700,
  );
  check(
    "slice markers stripped, real warnings kept",
    merged.warnings.length === 1 && merged.warnings[0] === "real_warning_keep_me",
  );
  check("parse_errors concatenated", merged.parse_errors.length === 1);
  check(
    "dispatched_sections unioned",
    merged.dispatched_sections.length === 2,
  );
  check("column_wrap_decision from MN unit", !!merged.column_wrap_decision);
}
{
  let threw = false;
  try {
    mergeEocFragments({});
  } catch {
    threw = true;
  }
  check("empty fragments → throws (never assemble nothing)", threw);
}

// ── PART 3 — heartbeat + slices + runlog ─────────────────────────────────────
console.log("\nPART 3 — heartbeat, slices, runlog:");
{
  const s = freshState();
  const hb = Date.parse(NOW);
  check("fresh heartbeat (30s) → duplicate delivery skips", heartbeatIsFresh(s, hb + 30_000, 120_000));
  check("stale heartbeat (3 min) → retry proceeds", !heartbeatIsFresh(s, hb + 180_000, 120_000));
  // THE STALL-BUG CONTRACT: a clean checkpoint handoff writes a fresh
  // heartbeat then re-enqueues — its own delivery (seconds later) must
  // PROCEED, not dup-skip; only handoff-less fresh heartbeats are duplicates.
  check(
    "fresh heartbeat + awaiting_resume (clean handoff) → PROCEEDS",
    !shouldSkipAsDuplicateDelivery({ ...s, awaiting_resume: true }, hb + 2_000, 120_000),
  );
  check(
    "fresh heartbeat + NO handoff (sibling alive mid-unit) → skips",
    shouldSkipAsDuplicateDelivery(s, hb + 2_000, 120_000),
  );
  check(
    "stale heartbeat + NO handoff (killed invocation's retry) → proceeds",
    !shouldSkipAsDuplicateDelivery(s, hb + 180_000, 120_000),
  );
}
{
  const id = unitParseOptions("plan_identity");
  const aca = unitParseOptions("aca");
  const mn = unitParseOptions("medical_necessity");
  const tail = unitParseOptions("tail_sections");
  check("identity unit: sections empty + aca skipped", id.sectionFilter.length === 0 && id.skipAca && !id.skipPlanIdentity);
  check("aca unit: identity skipped + aca runs", aca.skipPlanIdentity && !aca.skipAca);
  check(
    "MN unit carries the prose-PA leg key",
    mn.sectionFilter.includes("medical_necessity" as never) &&
      (mn.sectionFilter as string[]).includes("prior_auth_prose"),
  );
  check("tail unit = cob+eligibility+definitions", tail.sectionFilter.length === 3);
  check(
    "every unit list name is unique + ordered constant",
    new Set(EOC_RESUME_UNITS).size === EOC_RESUME_UNITS.length && EOC_RESUME_UNITS[0] === "plan_identity",
  );
}
{
  const s = freshState();
  s.units.plan_identity = { status: "done", attempts: 1, cost_usd: 0.02, ms: 9000 };
  const log = buildEocParseRunlog(s, "completed");
  check(
    "runlog carries outcome + per-unit attempts/cost/ms + invocations",
    log.outcome === "completed" && log.invocations === 1 && log.units.plan_identity.cost_usd === 0.02,
  );
  const logF = buildEocParseRunlog(s, "completed", { assemble: 12, sections_persist: 4000 });
  check(
    "runlog finish_ms passthrough (Phase B persist stopwatch)",
    logF.finish_ms?.sections_persist === 4000 && log.finish_ms === undefined,
  );
}

// ── PART 4 — Phase B: wave scheduler + Slack builder ─────────────────────────
console.log("\nPART 4 — runnableUnits (wave) + Slack notifier:");
{
  const s = freshState();
  const w = runnableUnits(s, CAPS, 3);
  check(
    "fresh state, pool 3 → [plan_identity, aca, medical_necessity] (identity-first critical path)",
    w.length === 3 && w[0] === "plan_identity" && w[1] === "aca" && w[2] === "medical_necessity",
  );
  check("pool 1 → sequential rollback (single unit, in order)", runnableUnits(s, CAPS, 1).join() === "plan_identity");
  check("pool larger than pending → all pending, no padding", runnableUnits(s, CAPS, 99).length === EOC_RESUME_UNITS.length);
}
{
  const s = freshState();
  s.units.plan_identity = { status: "done", attempts: 1, cost_usd: 0.01, ms: 1 };
  s.units.aca.attempts = 2; // attempt-capped — must be EXCLUDED from waves
  const w = runnableUnits(s, CAPS, 3);
  check(
    "done + attempt-capped units excluded from the wave",
    !w.includes("plan_identity") && !w.includes("aca") && w[0] === "medical_necessity",
  );
}
{
  const text = buildEocParseSlackText({
    outcome: "processed",
    documentId: "doc-1",
    fileName: "ecm-12-eoc-only.pdf",
    invocations: 1,
    totalCostUsd: 0.151,
    units: { plan_identity: { attempts: 1, ms: 147000, cost_usd: 0 }, medical_necessity: { attempts: 2, ms: 33000, cost_usd: 0.1 } },
    finishMs: { assemble: 15, sections_persist: 42000 },
    wallMs: 210_000,
  });
  check(
    "Slack success text carries file + spend + unit timings + finish breakdown + retries",
    text.includes("ecm-12-eoc-only.pdf") &&
      text.includes("$0.151") &&
      text.includes("147.0s") &&
      text.includes("attempts=2") &&
      text.includes("sections_persist: 42.0s") &&
      text.includes(":white_check_mark:"),
  );
  const failText = buildEocParseSlackText({
    outcome: "eoc_finish_exception: boom",
    documentId: "doc-1",
    fileName: "ecm-12-eoc-only.pdf",
    invocations: 3,
    totalCostUsd: 0.2,
    units: {},
  });
  check(
    "Slack failure text carries the reason loudly",
    failText.includes(":rotating_light:") && failText.includes("eoc_finish_exception: boom"),
  );
  const saved = process.env.SLACK_EOC_PARSE_CHANNEL_ID;
  delete process.env.SLACK_EOC_PARSE_CHANNEL_ID;
  check("channel resolution: unset everywhere → null (skip, never a wrong default)", resolveEocSlackChannelId("") === null);
  check("channel resolution: config value used when env absent", resolveEocSlackChannelId("C123") === "C123");
  if (saved !== undefined) process.env.SLACK_EOC_PARSE_CHANNEL_ID = saved;
}

console.log(`\n${pass}/${pass + fail} assertions passed.`);
if (fail > 0) {
  console.error(`${fail} FAILED`);
  process.exit(1);
}
