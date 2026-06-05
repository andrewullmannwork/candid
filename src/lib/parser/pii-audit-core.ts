/**
 * Ing-E G7 — shared PII-sweep core (deployed; used by BOTH the daily cron route
 * (/api/cron/pii-audit) AND the calibration audit).
 *
 * The exhaustive sweep + the per-unit classification live here once so the runtime
 * detector and the manual audit can never disagree about what counts as PII. Detection
 * itself delegates to the deployed redactor primitives (autoRedactableMatches /
 * redactText / hasCoverageTokens) — the redactor is the single ground truth for "what
 * gets redacted"; this module never re-defines that predicate.
 *
 * AGGREGATE COUNTS ONLY — never returns or stores raw excerpt text.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { autoRedactableMatches, hasCoverageTokens } from "./pii-patterns";
import { redactText } from "./pii-redactor";
import { SWEPT_SURFACES, type CanonicalSurface } from "./pii-surfaces";
import { extractUnits, fetchSurfaceRows } from "./pii-surface-iter";

const RUN_TABLE = "pii_audit_runs";
// Liveness threshold: a daily cron silent for >this ⇒ it was offline ⇒ alert on resume.
// Env-tunable (no code change) so ops can widen it during a known maintenance window — keep
// it in step with the vercel.json cron cadence (daily = 24h; default 25 = 24h + 1h grace).
// Safe ~24–48; <24 risks false liveness alarms on normal cron jitter. (Ing-E Ship Gate G6.)
const GAP_ALERT_HOURS = Number(process.env.PII_AUDIT_GAP_ALERT_HOURS) || 25;

export interface UnitClassification {
  /** The redactor would remove auto-tier PII from this unit (the primary alarm). */
  autoPii: boolean;
  /** Redaction dropped a coverage token — a redactor regression. */
  coverageLost: boolean;
  /** Re-redacting the redacted text changes again — a redactor regression. */
  nonIdempotent: boolean;
}

/** Single per-unit classification, shared by the cron sweep + (definitionally) the audit. */
export function classifyUnit(text: string): UnitClassification {
  // autoRedactableMatches is the canonical "what redactText acts on" query (pii-patterns).
  if (autoRedactableMatches(text).length === 0) {
    return { autoPii: false, coverageLost: false, nonIdempotent: false };
  }
  const r = redactText(text);
  return {
    autoPii: true,
    coverageLost: hasCoverageTokens(text) && !hasCoverageTokens(r.redacted),
    nonIdempotent: redactText(r.redacted).changed,
  };
}

export interface SurfaceSweep {
  id: string;
  rowsScanned: number;
  unitsScanned: number;
  autoPiiUnits: number;
  coverageLossUnits: number;
  nonIdempotentUnits: number;
  error?: string;
}
export interface PiiSweepResult {
  perSurface: SurfaceSweep[];
  surfacesSwept: number;
  surfacesErrored: number;
  unitsScanned: number;
  autoPiiUnits: number;
  coverageLossUnits: number;
  nonIdempotentUnits: number;
}

/**
 * Exhaustive aggregate sweep over the given surfaces (default: all SWEPT canonical /
 * cross-user surfaces). Read-only; aggregate counts only. A per-surface fetch/scan error
 * is captured (not thrown) so one bad table can't blind the whole sweep.
 */
export async function runPiiSweep(
  supabase: SupabaseClient,
  surfaces: readonly CanonicalSurface[] = SWEPT_SURFACES,
): Promise<PiiSweepResult> {
  const perSurface: SurfaceSweep[] = [];
  for (const surface of surfaces) {
    const s: SurfaceSweep = {
      id: surface.id, rowsScanned: 0, unitsScanned: 0,
      autoPiiUnits: 0, coverageLossUnits: 0, nonIdempotentUnits: 0,
    };
    try {
      const { rows, hasId } = await fetchSurfaceRows(supabase, surface.table, surface.column);
      s.rowsScanned = rows.length;
      let idx = 0;
      for (const row of rows) {
        const rowId = hasId ? String(row.id ?? `row#${idx}`) : `row#${idx}`;
        idx++;
        for (const unit of extractUnits(surface, row, rowId)) {
          s.unitsScanned++;
          const c = classifyUnit(unit.text);
          if (c.autoPii) s.autoPiiUnits++;
          if (c.coverageLost) s.coverageLossUnits++;
          if (c.nonIdempotent) s.nonIdempotentUnits++;
        }
      }
    } catch (e) {
      s.error = (e as Error).message;
    }
    perSurface.push(s);
  }
  const t = perSurface.reduce(
    (a, s) => ({
      unitsScanned: a.unitsScanned + s.unitsScanned,
      autoPiiUnits: a.autoPiiUnits + s.autoPiiUnits,
      coverageLossUnits: a.coverageLossUnits + s.coverageLossUnits,
      nonIdempotentUnits: a.nonIdempotentUnits + s.nonIdempotentUnits,
    }),
    { unitsScanned: 0, autoPiiUnits: 0, coverageLossUnits: 0, nonIdempotentUnits: 0 },
  );
  return {
    perSurface,
    surfacesSwept: perSurface.filter((s) => !s.error).length,
    surfacesErrored: perSurface.filter((s) => s.error).length,
    ...t,
  };
}

export interface PiiAuditRunOutcome {
  status: "clean" | "alert" | "error";
  /** PII / coverage-loss / non-idempotency present in the sweep. */
  fired: boolean;
  /** fired || a surface errored || a liveness gap → Slack should post. */
  shouldAlert: boolean;
  gapHours: number | null;
  prevRunAt: string | null;
  /** Aggregate-only summary text for Slack (NO raw PII). */
  summary: string;
}

/**
 * Record one sweep into pii_audit_runs (fire + non-fire = G7 telemetry) and decide
 * whether to alert. The DB write is NON-FATAL — detection + alerting must not depend on
 * the telemetry insert succeeding. Liveness: a >25h gap since the prior run is itself an
 * alert (the detector was offline).
 */
export async function recordPiiAuditRun(
  supabase: SupabaseClient,
  sweep: PiiSweepResult,
  trigger: "cron" | "manual",
): Promise<PiiAuditRunOutcome> {
  const fired = sweep.autoPiiUnits > 0 || sweep.coverageLossUnits > 0 || sweep.nonIdempotentUnits > 0;
  const errored = sweep.surfacesErrored > 0;
  const status: "clean" | "alert" | "error" = errored ? "error" : fired ? "alert" : "clean";

  let prevRunAt: string | null = null;
  let gapHours: number | null = null;
  try {
    const { data } = await supabase
      .from(RUN_TABLE)
      .select("run_at")
      .order("run_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    prevRunAt = (data as { run_at?: string } | null)?.run_at ?? null;
    if (prevRunAt) gapHours = (Date.now() - new Date(prevRunAt).getTime()) / 3_600_000;
  } catch {
    /* table may not exist pre-migration — treat as no prior run */
  }
  const gapAlert = gapHours != null && gapHours > GAP_ALERT_HOURS;
  const shouldAlert = fired || errored || gapAlert;

  const detail = {
    perSurface: sweep.perSurface.map((s) => ({
      id: s.id, rows: s.rowsScanned, units: s.unitsScanned,
      autoPii: s.autoPiiUnits, coverageLoss: s.coverageLossUnits, nonIdempotent: s.nonIdempotentUnits,
      ...(s.error ? { error: s.error } : {}),
    })),
  };

  try {
    await supabase.from(RUN_TABLE).insert({
      trigger,
      surfaces_swept: sweep.surfacesSwept,
      surfaces_errored: sweep.surfacesErrored,
      units_scanned: sweep.unitsScanned,
      auto_pii_count: sweep.autoPiiUnits,
      coverage_loss_count: sweep.coverageLossUnits,
      non_idempotent_count: sweep.nonIdempotentUnits,
      status,
      alerted: shouldAlert,
      detail,
    });
  } catch (e) {
    console.warn(`[pii-audit] run-ledger insert failed (non-fatal): ${(e as Error).message}`);
  }

  return { status, fired, shouldAlert, gapHours, prevRunAt, summary: buildSweepSummary(sweep, status, gapHours, gapAlert) };
}

/** Aggregate-only Slack/console summary — never includes raw excerpt text. */
export function buildSweepSummary(sweep: PiiSweepResult, status: string, gapHours: number | null, gapAlert: boolean): string {
  const offenders = sweep.perSurface.filter((s) => s.autoPiiUnits || s.coverageLossUnits || s.nonIdempotentUnits || s.error);
  const lines = [
    `status=${status} | surfaces ${sweep.surfacesSwept} swept / ${sweep.surfacesErrored} errored | units ${sweep.unitsScanned}`,
    `autoPII=${sweep.autoPiiUnits} coverageLoss=${sweep.coverageLossUnits} nonIdempotent=${sweep.nonIdempotentUnits}`,
  ];
  if (gapAlert && gapHours != null) {
    lines.push(`:warning: liveness gap: previous run ${gapHours.toFixed(1)}h ago (>${GAP_ALERT_HOURS}h — detector may have been offline)`);
  }
  for (const s of offenders) {
    lines.push(`• ${s.id}: autoPII=${s.autoPiiUnits} coverageLoss=${s.coverageLossUnits} nonIdempotent=${s.nonIdempotentUnits}${s.error ? ` error=${s.error}` : ""}`);
  }
  return lines.join("\n");
}
