/**
 * GET /api/cron/id-block-reeval (ID-Block PR3c, S176).
 *
 * Daily Vercel cron. Re-evaluates every held canonical_promotion_quarantine row
 * ("delayed, not denied"): re-runs the corroboration legitimacy gate and, for rows whose
 * cluster legitimacy now clears, auto-releases the withheld doc-type promotion via the
 * real CF-40 promote mechanism. Still-suspicious / cluster-gone / Layer-4 / drifted rows
 * stay held and reschedule. No admin approval is required (the admin Confirm/Clear/Hold
 * actions remain an optional early push). Inert until active-hold (0 held rows in shadow).
 *
 * Aggregate telemetry only (fire + non-fire = G7) — never raw user data. Releases also
 * fire a Slack to the ID-Block channel.
 *
 * Auth: CRON_SECRET (matches the existing /api/cron/* pattern). Service-role client
 * (createServerClient) so the sweep bypasses RLS — canonical_promotion_quarantine is
 * service-role only; an anon client would read 0 rows and report a false "clean".
 */
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { runReEvalSweep } from "@/lib/parser/id-block/reeval-sweep";
import { isAuthorizedCron } from "@/lib/security/require-cron-secret";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();
  try {
    const summary = await runReEvalSweep(supabase);
    return NextResponse.json({ ok: true, ...summary, ran_at: new Date().toISOString() });
  } catch (err) {
    console.error("[cron/id-block-reeval] run failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), ran_at: new Date().toISOString() },
      { status: 500 },
    );
  }
}
