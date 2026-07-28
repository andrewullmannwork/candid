import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/require-admin";

/**
 * GET /api/admin/growth-metrics?window=7d|30d|all — channel-attribution
 * aggregates for the /admin/growth dashboard (GTM playbook 04).
 *
 * v1.1: aggregation moved into the growth_metrics() SQL RPC (mig 205) — the
 * v1 TS aggregation read tables PostgREST silently caps at 1,000 rows
 * (documents was already past it → silent undercount; the in-code 20k limit
 * never saw the server-side cap). SQL has no row ceiling, excludes is_admin
 * users (founder/test activity is not growth), and adds verified signups,
 * bills vs plan-docs split, top landing pages, and top pages by server-side
 * pageview counts (mig 204).
 *
 * Aggregates only — no individual user rows leave this route.
 */

type WindowKey = "7d" | "30d" | "all";

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;
  const { supabase } = admin;

  const winParam = req.nextUrl.searchParams.get("window");
  const win: WindowKey = winParam === "7d" || winParam === "all" ? winParam : "30d";

  const { data, error } = await supabase.rpc("growth_metrics", { win });
  if (error || !data) {
    console.error("[admin/growth-metrics] growth_metrics RPC failed:", error);
    return NextResponse.json({ error: "Failed to load metrics" }, { status: 500 });
  }

  // S290 — /learn thumbs aggregates (mig 215; additive companion RPC so the
  // live growth_metrics body is never CREATE-OR-REPLACEd). Degrades to null
  // when the RPC isn't applied yet — the dashboard section then self-hides.
  let guideFeedback: unknown = null;
  const gf = await supabase.rpc("guide_feedback_metrics", { win });
  if (gf.error) {
    console.warn("[admin/growth-metrics] guide_feedback_metrics unavailable:", gf.error.message);
  } else {
    guideFeedback = gf.data ?? null;
  }

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    window: win,
    guideFeedback,
    ...(data as Record<string, unknown>),
  });
}
