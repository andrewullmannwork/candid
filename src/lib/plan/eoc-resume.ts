/**
 * EOC-RESUME (S195) — checkpointed, re-enqueueing EOC parse.
 *
 * WHY: a full EOC parse (~99-page docs, 7 Haiku legs, hundreds of chunk calls)
 * does not fit inside one Vercel invocation (`process-chunk` maxDuration 800s).
 * The S195 E2E surfaced this the first time the EOC parser EVER ran in PROD
 * (the dispatch bug fixed in #189 had kept it unreachable): three real parses
 * died at the ceiling with zero persisted output and invisible spend.
 *
 * SHAPE: the parse is split into WORK UNITS — each one a `parseEOC` call
 * sliced via the existing calibration knobs (`sectionFilter` /
 * `skipPlanIdentity` / `skipAca`, built for T5 and golden-tested). Each
 * invocation runs remaining units inside a soft time budget, stashes each
 * unit's raw `EOCParseResult` fragment into `documents.metadata
 * .eoc_parse_state` (JSONB-first per Rule 9 — no migration), and re-enqueues
 * itself via QStash when the budget runs out. When every unit is done, the
 * fragments are ASSEMBLED into one complete `EOCParseResult` and the existing
 * persistence pipeline runs UNCHANGED — so nothing user-visible persists until
 * the parse fully completes (no partial plan rows from dead parses), and the
 * persistence semantics (D4 stale-key clears, REPLACE-per-parse facts, byte
 * contracts) are untouched.
 *
 * MONEY-FIRE GUARDS (the S195 lesson): per-unit attempt cap (a unit that dies
 * twice fails the doc loudly instead of looping), total-invocation cap, and a
 * cumulative cost rail checked BETWEEN units — all config-backed on
 * `eoc_parser_v1.config` (G6). Mid-flight spend is visible in the state blob
 * (per-unit cost), not just in a post-hoc aggregate that never lands when the
 * function dies.
 *
 * This module is PURE (no I/O): unit definitions, the scheduler decision, and
 * the fragment assembler — all fixture-tested
 * (scripts/calibration/fixtures/thesaurus-phase1a/eoc-resume.ts). The I/O
 * driver lives in process-eoc.ts.
 */

import type { EOCParseResult, EOCSectionHint } from "@/lib/eoc/types";

// ── Work units ────────────────────────────────────────────────────────────────

export type EocUnitName =
  | "plan_identity"
  | "aca"
  | "medical_necessity" // includes the D-P2-4 prose-PA leg — they merge pre-persist
  | "prior_auth_codes"
  | "appeals_procedures"
  | "tail_sections"; // cob_rules + eligibility_rules + definitions (three small legs)

/** Execution order. MN (the heaviest unit) runs after the two cheap legs so a
 * first-invocation budget breach still banks identity+aca before re-enqueueing. */
export const EOC_RESUME_UNITS: readonly EocUnitName[] = [
  "plan_identity",
  "aca",
  "medical_necessity",
  "prior_auth_codes",
  "appeals_procedures",
  "tail_sections",
] as const;

export interface EocUnitParseOptions {
  sectionFilter: EOCSectionHint[];
  skipPlanIdentity: boolean;
  skipAca: boolean;
}

/** parseEOC slice options per unit. `prior_auth_prose` is the D-P2-4 leg's
 * filterKey — not a member of the EOCSectionHint union (the parser casts its
 * own filterKey the same way; the T5 harness passes it identically). */
export function unitParseOptions(unit: EocUnitName): EocUnitParseOptions {
  switch (unit) {
    case "plan_identity":
      return { sectionFilter: [], skipPlanIdentity: false, skipAca: true };
    case "aca":
      return { sectionFilter: [], skipPlanIdentity: true, skipAca: false };
    case "medical_necessity":
      return {
        sectionFilter: ["medical_necessity", "prior_auth_prose" as EOCSectionHint],
        skipPlanIdentity: true,
        skipAca: true,
      };
    case "prior_auth_codes":
      return { sectionFilter: ["prior_auth_codes"], skipPlanIdentity: true, skipAca: true };
    case "appeals_procedures":
      return { sectionFilter: ["appeals_procedures"], skipPlanIdentity: true, skipAca: true };
    case "tail_sections":
      return {
        sectionFilter: ["cob_rules", "eligibility_rules", "definitions"],
        skipPlanIdentity: true,
        skipAca: true,
      };
  }
}

// ── Checkpoint state (documents.metadata.eoc_parse_state) ────────────────────

export interface EocUnitState {
  status: "pending" | "done";
  /** Times this unit has been STARTED (bumped before the parseEOC call). */
  attempts: number;
  cost_usd?: number;
  ms?: number;
}

export interface EocParseState {
  version: 1;
  run_id: string;
  started_at: string;
  /** Bumped at invocation start + after each unit — duplicate-delivery guard
   * and "is anything alive?" signal (a killed function leaves it stale). */
  heartbeat_at: string;
  invocations: number;
  /** S195 hardening — optimistic-claim revision. Bumped on every CLAIM write;
   * a claimant that loads state at rev N and finds rev≠N at claim time lost
   * the race to a sibling and abandons quietly. With the QStash publish
   * timeout fix the race class should not occur at all; this is the belt to
   * that suspender (the night-1 run showed concurrent claimants clobbering
   * each other's checkpoint state via unguarded read-merge-write). */
  state_rev?: number;
  /** TRUE between a clean checkpoint handoff (state written + re-enqueue
   * fired) and the next invocation picking the work up. The duplicate-delivery
   * guard skips ONLY on a fresh heartbeat WITHOUT this flag — otherwise the
   * re-enqueued delivery (arriving ~2s after the checkpoint's own heartbeat
   * write) would no-op against its own handoff and stall the parse. A killed
   * invocation never sets it, so genuine-duplicate suppression still works. */
  awaiting_resume?: boolean;
  /** Snapshot of `eoc_prose_prior_auth_v1` at run start — the M1 single-read
   * consistency contract extended across invocations (no mid-run flag flip
   * splitting the parse's brain). */
  routing_flag_snapshot: boolean;
  units: Record<EocUnitName, EocUnitState>;
  /** Raw per-unit EOCParseResult fragments; cleared on finish/fail. */
  fragments: Partial<Record<EocUnitName, EOCParseResult>>;
}

export function initEocParseState(nowIso: string, routingFlagOn: boolean, runId: string): EocParseState {
  const units = {} as Record<EocUnitName, EocUnitState>;
  for (const u of EOC_RESUME_UNITS) units[u] = { status: "pending", attempts: 0 };
  return {
    version: 1,
    run_id: runId,
    started_at: nowIso,
    heartbeat_at: nowIso,
    invocations: 0,
    routing_flag_snapshot: routingFlagOn,
    units,
    fragments: {},
  };
}

export function hasPendingUnits(state: EocParseState | null | undefined): boolean {
  if (!state || state.version !== 1 || !state.units) return false;
  return EOC_RESUME_UNITS.some((u) => state.units[u]?.status !== "done");
}

/** Stale-heartbeat check: a fresh heartbeat means another invocation is (very
 * likely) alive right now — the duplicate QStash delivery should no-op. */
export function heartbeatIsFresh(state: EocParseState, nowMs: number, freshWindowMs: number): boolean {
  const hb = Date.parse(state.heartbeat_at);
  if (Number.isNaN(hb)) return false;
  return nowMs - hb < freshWindowMs;
}

/**
 * The duplicate-delivery decision: skip ONLY when the heartbeat is fresh AND
 * no handoff is pending. A fresh heartbeat WITH `awaiting_resume` is the
 * normal checkpoint handoff (the re-enqueued delivery arriving seconds after
 * the checkpoint's own heartbeat write) and MUST proceed — treating it as a
 * duplicate would stall the parse forever with pending units and no scheduled
 * work. A killed invocation never sets the flag, so true duplicates (and
 * QStash retries landing while a sibling is mid-unit) still no-op.
 */
export function shouldSkipAsDuplicateDelivery(
  state: EocParseState,
  nowMs: number,
  freshWindowMs: number,
): boolean {
  return !state.awaiting_resume && heartbeatIsFresh(state, nowMs, freshWindowMs);
}

export function cumulativeCostUsd(state: EocParseState): number {
  let sum = 0;
  for (const u of EOC_RESUME_UNITS) sum += state.units[u]?.cost_usd ?? 0;
  return sum;
}

// ── Scheduler decision (pure) ────────────────────────────────────────────────

export interface EocResumeCaps {
  unitAttemptCap: number;
  maxInvocations: number;
  maxCostUsd: number;
}

export type EocNextWork =
  | { action: "run"; unit: EocUnitName }
  | { action: "assemble" }
  | { action: "fail"; reason: string };

export function planNextEocWork(state: EocParseState, caps: EocResumeCaps): EocNextWork {
  // S195 hardening: assemble is EXEMPT from every cap. When all units are
  // done, every Haiku dollar is already banked — refusing to finish on a
  // counter would throw a complete parse away. (Observed night-1: duplicate
  // claimants clobber-bumped `invocations` past the cap while sitting at 6/6.)
  // Caps exist to bound UNIT work, and are checked only when units remain.
  const pending = EOC_RESUME_UNITS.filter((u) => state.units[u]?.status !== "done");
  if (pending.length === 0) {
    return { action: "assemble" };
  }
  if (state.invocations > caps.maxInvocations) {
    return {
      action: "fail",
      reason: `eoc_resume_invocation_cap:${state.invocations}>${caps.maxInvocations}`,
    };
  }
  const spent = cumulativeCostUsd(state);
  if (spent > caps.maxCostUsd) {
    return {
      action: "fail",
      reason: `eoc_resume_cost_cap:$${spent.toFixed(4)}>$${caps.maxCostUsd.toFixed(2)}`,
    };
  }
  const u = pending[0];
  const us = state.units[u];
  if (us.attempts >= caps.unitAttemptCap) {
    return {
      action: "fail",
      reason: `eoc_resume_unit_attempt_cap:${u}:${us.attempts}>=${caps.unitAttemptCap}`,
    };
  }
  return { action: "run", unit: u };
}

/**
 * S195 Phase B — the units to launch CONCURRENTLY this wave: pending units
 * whose attempt budget remains, in canonical order (plan_identity first — it
 * is the measured critical path at ~147s; everything else drafts behind it),
 * sliced to the pool size. Pool size 1 reproduces the exact sequential
 * behavior (the rollback dial). Caller consults `planNextEocWork` FIRST for
 * fail/assemble authority; this only shapes the "run" action into a wave.
 */
export function runnableUnits(
  state: EocParseState,
  caps: EocResumeCaps,
  maxPool: number,
): EocUnitName[] {
  const pool = Math.max(1, Math.floor(maxPool));
  return EOC_RESUME_UNITS.filter(
    (u) => state.units[u]?.status !== "done" && (state.units[u]?.attempts ?? 0) < caps.unitAttemptCap,
  ).slice(0, pool);
}

// ── Fragment assembly (pure) ─────────────────────────────────────────────────

/** Slice artifacts emitted by parseEOC when a leg/section is skipped by the
 * unit's filter — noise relative to the ASSEMBLED whole, stripped on merge. */
const SLICE_MARKER_PREFIXES = [
  "plan_identity_skipped_by_option",
  "eoc_aca_skipped_by_option",
  "eoc_section_skipped_by_filter:",
];

function isSliceMarker(w: string): boolean {
  return SLICE_MARKER_PREFIXES.some((p) => w.startsWith(p));
}

/**
 * Assemble one complete EOCParseResult from per-unit fragments, equivalent to
 * what a single monolithic parseEOC call would have produced:
 *  - plan_identity / aca_compliance from their dedicated units
 *  - sections spread-merged (each fragment carries ONLY its dispatched keys)
 *  - cost/token totals summed; timings recomposed per leg
 *  - slice-marker warnings stripped; real warnings/parse_errors concatenated
 *  - segmentation diagnostics from the first SECTION unit (every unit re-runs
 *    the same deterministic segmentation over the same text)
 *  - column_wrap_decision from the medical_necessity unit (its self-check is
 *    the consumer)
 */
export function mergeEocFragments(
  fragments: Partial<Record<EocUnitName, EOCParseResult>>,
): EOCParseResult {
  const ordered = EOC_RESUME_UNITS.map((u) => fragments[u]).filter(
    (f): f is EOCParseResult => !!f,
  );
  if (ordered.length === 0) {
    throw new Error("mergeEocFragments: no fragments to assemble");
  }
  const identityFrag = fragments.plan_identity ?? ordered[0];
  const acaFrag = fragments.aca ?? null;
  const firstSectionFrag =
    fragments.medical_necessity ??
    fragments.prior_auth_codes ??
    fragments.appeals_procedures ??
    fragments.tail_sections ??
    ordered[0];

  const sections: EOCParseResult["sections"] = {};
  const warnings: string[] = [];
  const parseErrors: EOCParseResult["parse_errors"] = [];
  const dispatched = new Set<EOCSectionHint>();
  let cost = 0;
  let tokIn = 0;
  let tokOut = 0;
  let cacheCreate = 0;
  let cacheRead = 0;
  let sectionsMs = 0;
  let totalMs = 0;

  for (const f of ordered) {
    Object.assign(sections, f.sections);
    for (const w of f.warnings) if (!isSliceMarker(w)) warnings.push(w);
    parseErrors.push(...f.parse_errors);
    for (const d of f.dispatched_sections) dispatched.add(d);
    cost += f.total_cost_usd;
    tokIn += f.total_input_tokens;
    tokOut += f.total_output_tokens;
    cacheCreate += f.total_cache_create_tokens;
    cacheRead += f.total_cache_read_tokens;
    sectionsMs += f.timings.sections_ms;
    totalMs += f.timings.total_ms;
  }

  return {
    plan_identity: identityFrag.plan_identity,
    aca_compliance: acaFrag ? acaFrag.aca_compliance : null,
    sections,
    total_cost_usd: cost,
    total_input_tokens: tokIn,
    total_output_tokens: tokOut,
    total_cache_create_tokens: cacheCreate,
    total_cache_read_tokens: cacheRead,
    timings: {
      plan_identity_ms: identityFrag.timings.plan_identity_ms,
      aca_ms: acaFrag?.timings.aca_ms ?? 0,
      sections_ms: sectionsMs,
      total_ms: totalMs,
    },
    segmentation_used: firstSectionFrag.segmentation_used,
    warnings,
    parse_errors: parseErrors,
    dispatched_sections: [...dispatched],
    ...(fragments.medical_necessity?.column_wrap_decision
      ? { column_wrap_decision: fragments.medical_necessity.column_wrap_decision }
      : {}),
  };
}

/** Compact post-run observability blob (replaces the fragments on finish) —
 * per-unit cost/latency/attempts answer "where do PROD minutes go" with data.
 * S195 Phase B: optionally carries the finish-phase step timings (assemble →
 * persist → corroboration → audit → summary) so the persist tail is measured,
 * not guessed. */
export function buildEocParseRunlog(
  state: EocParseState,
  outcome: "completed" | string,
  finishMs?: Record<string, number>,
): {
  outcome: string;
  invocations: number;
  total_cost_usd: number;
  units: Record<string, { attempts: number; cost_usd?: number; ms?: number }>;
  finish_ms?: Record<string, number>;
  started_at: string;
  finished_at: string;
} {
  const units: Record<string, { attempts: number; cost_usd?: number; ms?: number }> = {};
  for (const u of EOC_RESUME_UNITS) {
    const us = state.units[u];
    units[u] = { attempts: us.attempts, cost_usd: us.cost_usd, ms: us.ms };
  }
  return {
    outcome,
    invocations: state.invocations,
    total_cost_usd: cumulativeCostUsd(state),
    units,
    ...(finishMs && Object.keys(finishMs).length > 0 ? { finish_ms: finishMs } : {}),
    started_at: state.started_at,
    finished_at: state.heartbeat_at,
  };
}
