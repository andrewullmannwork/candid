/**
 * GET /api/cron/pii-audit (Ing-E G7, S167).
 *
 * Daily Vercel cron (07:00 UTC). Exhaustively sweeps every cross-user free-text surface,
 * runs the redactor's classification over each unit, records the run to pii_audit_runs
 * (fire + non-fire = G7 telemetry), and Slack-alerts the dedicated PII channel on any
 * auto-tier PII, coverage-loss, non-idempotency, sweep error, OR a >25h liveness gap.
 * Aggregate counts only — never raw excerpt text.
 *
 * Auth: CRON_SECRET (matches the existing /api/cron/* pattern). Service-role client
 * (createServerClient) so the sweep bypasses RLS — an anon client would read 0 rows and
 * report a false "clean".
 */
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { runPiiSweep, recordPiiAuditRun } from "@/lib/parser/pii-audit-core";
import { postPiiAlert } from "@/lib/parser/pii-alert-slack";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // exhaustive sweep over ~30 tables

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();
  try {
    const sweep = await runPiiSweep(supabase);
    const outcome = await recordPiiAuditRun(supabase, sweep, "cron");
    if (outcome.shouldAlert) {
      await postPiiAlert(outcome.status, outcome.summary);
    }
    return NextResponse.json({
      ok: true,
      status: outcome.status,
      alerted: outcome.shouldAlert,
      totals: {
        surfacesSwept: sweep.surfacesSwept,
        surfacesErrored: sweep.surfacesErrored,
        unitsScanned: sweep.unitsScanned,
        autoPiiUnits: sweep.autoPiiUnits,
        coverageLossUnits: sweep.coverageLossUnits,
        nonIdempotentUnits: sweep.nonIdempotentUnits,
      },
      prevRunAt: outcome.prevRunAt,
      ran_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[cron/pii-audit] run failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), ran_at: new Date().toISOString() },
      { status: 500 },
    );
  }
}
