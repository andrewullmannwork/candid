/**
 * Dispute Deadline & Follow-up Engine — dispute-letters v2 S4 (map §3).
 *
 * Pure logic + one config reader. Given a letter type + the available anchor dates
 * (denial-notice / collector-first-contact / generation), it computes:
 *   - the GOVERNING DEADLINE the follow-ups track for this dispute (set on the
 *     dispute_outcomes row; NULL = no governing deadline → today's flat cadence), and
 *   - a GUARD verdict (ok | urgent | past) that lets the route refuse to assert a
 *     doomed "within the window" claim and surface the correct next step instead.
 *
 * Fail-closed everywhere: a missing/unparseable anchor yields a NULL deadline and an
 * `ok` (dormant) guard — never a fabricated date or a false urgency. All date math is
 * UTC and the guard rounds conservatively (never over-reports time remaining).
 *
 * The four tracked deadlines (map §3.1, counsel-blessed windows §10):
 *   erisa_appeal_180    — denial-notice date + 180d — the internal-appeal FILING window
 *                         (a GUARD on the insurer track: past → pivot to external review).
 *   plan_response       — I1 sent + 60d post-service / 30d pre-service — the plan's window
 *                         to respond; the follow-up clock STORED for the insurer track.
 *   fdcpa_validation_30 — collector first contact + 30d — the §1692g validation window
 *                         (collector track; also derives `debtWithinWindow`, unifying the
 *                         S2 route-computed check so there is ONE source).
 *   state_timely_billing— bill date; registry-gated → INERT (never computed at launch).
 *
 * Nothing here reads the feature flag — gating happens at the route boundary (the caller
 * only invokes this when dispute_deadline_engine_v1 is ON), so OFF is byte-identical.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type DeadlineType =
  | "erisa_appeal_180"
  | "plan_response"
  | "fdcpa_validation_30"
  | "state_timely_billing";

export type DeadlineSeverity = "ok" | "urgent" | "past";

export interface DeadlineConfig {
  /** Final-notice follow-up fires this many days BEFORE the governing deadline. */
  bufferDays: number;
  /** Per-track window lengths (days). Statutory defaults; overridable via flag config. */
  windowDays: {
    erisa_appeal_180: number;
    plan_response: number;
    plan_response_preservice: number;
    fdcpa_validation_30: number;
  };
  /** Graduated interim follow-up points as a fraction of the window (final = deadline − buffer). */
  followUpFractions: number[];
}

/** Statutory / counsel-blessed defaults (map §10). Also the code-side fallbacks. */
export const DEADLINE_DEFAULTS: DeadlineConfig = {
  bufferDays: 10,
  windowDays: {
    erisa_appeal_180: 180,
    plan_response: 60,
    plan_response_preservice: 30,
    fdcpa_validation_30: 30,
  },
  followUpFractions: [0.33, 0.66],
};

export interface DeadlineInput {
  letterType: string;
  /** ERISA anchor. No input path until S5 → null at S4 → erisa guard dormant (fail-closed). */
  denialNoticeDate?: string | null;
  /** FDCPA anchor (already user-supplied in the generate body, S2). */
  collectorFirstContactDate?: string | null;
  /** plan_response 60d (post-service, default) vs 30d (pre-service). */
  isPreService?: boolean;
  /** Injectable clock for deterministic fixtures; defaults to now. */
  now?: Date;
}

export interface DeadlineGuard {
  severity: DeadlineSeverity;
  deadlineType: DeadlineType | null;
  daysRemaining: number | null;
  nextStep: string | null;
}

export interface DeadlineResult {
  /** The follow-up clock stored on dispute_outcomes.governing_deadline_date (YYYY-MM-DD | null). */
  governingDeadlineDate: string | null;
  deadlineType: DeadlineType | null;
  guard: DeadlineGuard;
  /** Unifies the S2 route-computed §1692g in-window check (true only for an in-window collector letter). */
  debtWithinWindow: boolean;
}

// Letter-type → track. Kept local + explicit (recipient routing lives in templates/index; this is
// only the deadline classification). Provider letters have no statutory response deadline.
// external_review (I2) is the escalation TARGET of plan_response (map §3.1 "escalate I1→I2"), not a
// plan_response-tracked letter itself → it falls through to null (no governing deadline at launch).
const INSURER_TRACK = new Set<string>(["insurance_appeal"]);
const COLLECTOR_TRACK = new Set<string>(["debt_validation"]);

/**
 * The USER-SUPPLIED date this letter's governing deadline anchors on — null when
 * the letter has no dated window.
 *
 * Exported so `letterNeeds` derives its date asks from the engine that actually
 * consumes them (S301) instead of restating the mapping. Before this, the needs
 * panel asked for a denial date on final_notice and external_review, where the
 * engine never reads one and no template prints it — a dead ask on two letter
 * types. Add a type to a track above and the ask follows automatically; the two
 * can no longer drift apart.
 */
export function deadlineAnchorField(
  letterType: string,
): "denialNoticeDate" | "collectorFirstContactDate" | null {
  if (COLLECTOR_TRACK.has(letterType)) return "collectorFirstContactDate";
  if (INSURER_TRACK.has(letterType)) return "denialNoticeDate";
  return null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse a date string (YYYY-MM-DD or ISO) to epoch ms; null when absent/unparseable. */
function parseDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** Normalize an epoch ms to UTC midnight (so day-granular math is exact, no TZ/off-by-one). */
function utcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().split("T")[0];
}

/** anchorDate + windowDays, at UTC-midnight granularity. Null when the anchor is missing. */
function computeDeadline(
  anchorDate: string | null | undefined,
  windowDays: number,
): { deadlineMs: number; deadlineDate: string } | null {
  const anchorMs = parseDate(anchorDate);
  if (anchorMs === null) return null;
  const deadlineMs = utcMidnight(anchorMs) + windowDays * DAY_MS;
  return { deadlineMs, deadlineDate: toIsoDate(deadlineMs) };
}

const OK_GUARD: DeadlineGuard = { severity: "ok", deadlineType: null, daysRemaining: null, nextStep: null };

/** Classify a computed deadline vs now. `daysRemaining` is conservative (integer, UTC-exact). */
function classify(deadlineMs: number, nowMs: number, bufferDays: number, deadlineType: DeadlineType): DeadlineGuard {
  const daysRemaining = Math.round((deadlineMs - nowMs) / DAY_MS);
  const severity: DeadlineSeverity = daysRemaining < 0 ? "past" : daysRemaining <= bufferDays ? "urgent" : "ok";
  return { severity, deadlineType, daysRemaining, nextStep: null };
}

/**
 * Compute the governing deadline + guard for a dispute letter. Pure. Fail-closed.
 */
export function evaluateDeadline(input: DeadlineInput, config: DeadlineConfig): DeadlineResult {
  const nowMs = utcMidnight((input.now ?? new Date()).getTime());

  // ── Collector track — FDCPA §1692g 30-day validation window ──────────────────
  if (COLLECTOR_TRACK.has(input.letterType)) {
    const dl = computeDeadline(input.collectorFirstContactDate, config.windowDays.fdcpa_validation_30);
    if (!dl) {
      // No substantiated first-contact date → no §1692g teeth (fail-closed). The
      // §1692e(8) disputed-status marking still always fires (in the template, unconditioned).
      return { governingDeadlineDate: null, deadlineType: null, guard: OK_GUARD, debtWithinWindow: false };
    }
    const guard = classify(dl.deadlineMs, nowMs, config.bufferDays, "fdcpa_validation_30");
    if (guard.severity === "past") {
      guard.nextStep =
        "The 30-day validation window has closed; the cease-collection lever is no longer available. The §1692e(8) disputed-status marking still applies — consider disputing the debt through the credit bureaus.";
    }
    return {
      governingDeadlineDate: dl.deadlineDate,
      deadlineType: "fdcpa_validation_30",
      guard,
      debtWithinWindow: guard.severity !== "past",
    };
  }

  // ── Insurer track — plan_response follow-up clock, guarded by the ERISA 180-day filing window ──
  if (INSURER_TRACK.has(input.letterType)) {
    let guard: DeadlineGuard = OK_GUARD;
    const erisa = computeDeadline(input.denialNoticeDate, config.windowDays.erisa_appeal_180);
    if (erisa) {
      guard = classify(erisa.deadlineMs, nowMs, config.bufferDays, "erisa_appeal_180");
      if (guard.severity === "past") {
        guard.nextStep =
          "The 180-day internal-appeal window has closed; request an external review (independent/IRO review) or file a consumer-protection complaint instead of a standard internal appeal.";
      }
    }
    // Past the filing window → the internal appeal is time-barred; suppress the tracking deadline.
    if (guard.severity === "past") {
      return { governingDeadlineDate: null, deadlineType: null, guard, debtWithinWindow: false };
    }
    // Store the plan-response deadline (I1 sent proxy = generation date) as the follow-up clock.
    const windowDays = input.isPreService
      ? config.windowDays.plan_response_preservice
      : config.windowDays.plan_response;
    const planResp = computeDeadline(toIsoDate(nowMs), windowDays);
    return {
      governingDeadlineDate: planResp ? planResp.deadlineDate : null,
      deadlineType: planResp ? "plan_response" : null,
      guard,
      debtWithinWindow: false,
    };
  }

  // ── Provider track + state_timely_billing (INERT) — no governing deadline at launch ──
  return { governingDeadlineDate: null, deadlineType: null, guard: OK_GUARD, debtWithinWindow: false };
}

export type FollowupScheduleKind = "deadline_interim" | "deadline_final";

export interface FollowupScheduleEntry {
  dueDate: string; // YYYY-MM-DD
  kind: FollowupScheduleKind;
}

/**
 * Graduated follow-up schedule for a dispute WITH a governing deadline (map §3.3): interim nudges
 * at each configured fraction of the [today, deadline] window + a final notice at (deadline −
 * buffer). Interims must precede the final; when the buffer exceeds the remaining window there is
 * no final and interims run up to (but not including) the deadline, so a short window still gets
 * nudges. A deadline today/past → [] (schedule nothing; the past-window guard already warned). Pure;
 * final wins any same-day collision with an interim.
 */
export function computeFollowupSchedule(
  governingDeadlineDate: string,
  config: DeadlineConfig,
  now?: Date,
): FollowupScheduleEntry[] {
  const nowMs = utcMidnight((now ?? new Date()).getTime());
  const parsed = parseDate(governingDeadlineDate);
  if (parsed === null) return [];
  const deadlineMs = utcMidnight(parsed);
  const windowDays = Math.round((deadlineMs - nowMs) / DAY_MS);
  if (windowDays <= 0) return []; // deadline today/past → nothing to schedule

  const finalMs = deadlineMs - config.bufferDays * DAY_MS;
  const hasFinal = finalMs > nowMs;
  const interimCeiling = hasFinal ? finalMs : deadlineMs; // interims precede the final (or the deadline)

  const byDate = new Map<string, FollowupScheduleKind>();
  for (const f of config.followUpFractions) {
    const dueMs = nowMs + Math.round(f * windowDays) * DAY_MS;
    if (dueMs > nowMs && dueMs < interimCeiling) byDate.set(toIsoDate(dueMs), "deadline_interim");
  }
  if (hasFinal) byDate.set(toIsoDate(finalMs), "deadline_final"); // overwrites any same-day interim

  return [...byDate.entries()]
    .map(([dueDate, kind]) => ({ dueDate, kind }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function positiveNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Merge a raw `dispute_feedback_loop.config` JSONB into a typed DeadlineConfig, applying
 * per-key fallbacks so a malformed/absent key never throws. Pure (unit-testable without a DB).
 */
export function mergeDeadlineConfig(cfg: Record<string, unknown>): DeadlineConfig {
  const w = (cfg.deadline_window_days as Record<string, unknown> | undefined) ?? {};
  const fr = cfg.follow_up_fractions;
  const fractions =
    Array.isArray(fr) && fr.length > 0 && fr.every((x) => typeof x === "number" && x > 0 && x < 1)
      ? (fr as number[])
      : DEADLINE_DEFAULTS.followUpFractions;
  return {
    bufferDays: positiveNumber(cfg.deadline_buffer_days, DEADLINE_DEFAULTS.bufferDays),
    windowDays: {
      erisa_appeal_180: positiveNumber(w.erisa_appeal_180, DEADLINE_DEFAULTS.windowDays.erisa_appeal_180),
      plan_response: positiveNumber(w.plan_response, DEADLINE_DEFAULTS.windowDays.plan_response),
      plan_response_preservice: positiveNumber(
        w.plan_response_preservice,
        DEADLINE_DEFAULTS.windowDays.plan_response_preservice,
      ),
      fdcpa_validation_30: positiveNumber(w.fdcpa_validation_30, DEADLINE_DEFAULTS.windowDays.fdcpa_validation_30),
    },
    followUpFractions: fractions,
  };
}

/**
 * Read the cadence/window config off the EXISTING dispute_feedback_loop flag (mirrors
 * followups.ts readCadence — same flag, one place to tune). Falls back to statutory
 * defaults on any error/absence.
 */
export async function readDeadlineConfig(supabase: SupabaseClient): Promise<DeadlineConfig> {
  try {
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("config")
      .eq("flag_key", "dispute_feedback_loop")
      .maybeSingle();
    const cfg = (data?.config as Record<string, unknown> | undefined) ?? {};
    return mergeDeadlineConfig(cfg);
  } catch {
    return DEADLINE_DEFAULTS;
  }
}
