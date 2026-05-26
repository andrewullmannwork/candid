/**
 * GET /api/cron/cost-per-canonical-alerts (Cost-F, S129).
 *
 * Daily Vercel cron (09:00 UTC). Evaluates per-canonical cost thresholds
 * against the unified parse_cost_events ledger + fires Slack alerts on
 * breach (relative spike 2x baseline OR absolute > $5). Dedup 24h per
 * (canonical_id, alert_type) pair via cost_alert_log.
 *
 * Auth: CRON_SECRET (matches existing /api/cron/retry-stuck pattern).
 *
 * Slack webhook: SLACK_COST_ALERTS_WEBHOOK_URL env var. If unset, alerts
 * are still logged to cost_alert_log with slack_delivery_status='skipped_no_webhook'
 * for audit (operator sets env var in Vercel post-merge to enable delivery).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { evaluateAndFireAlerts } from "@/lib/cost/cost-alert-engine";

export async function GET(req: NextRequest) {
  // Verify Vercel cron secret (Vercel auto-includes this header on scheduled invocations)
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  try {
    const result = await evaluateAndFireAlerts(supabase);
    return NextResponse.json({
      ok: true,
      ...result,
      ran_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[cost-per-canonical-alerts] cron run failed:", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ran_at: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
