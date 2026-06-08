/**
 * Admin GET for /admin/promotion-quarantine — the ID-Block corroboration
 * source-independence work-list (PR3a, read-only).
 *
 * Surfaces canonical_promotion_quarantine (mig 158) as the §4 FULL input inventory:
 * per cluster (§4.2) AND per corroborating user (§4.1) every raw signal + the gate's
 * exact legitimacy sub-score/contributions + a LIVE "would it still flag now?" preview
 * (the PR3c re-eval, previewed read-only). Empty in PROD until id_block_corroboration
 * flips to shadow — this is the surface that makes the shadow-measure observable.
 *
 *   GET ?scope=live   → state IN (shadow, held)        (default — the active queue)
 *   GET ?scope=all    → + cleared/promoted (history)
 *
 * Read-only: NO writes. Per-cluster Confirm/Clear/Hold + inline config editing land in
 * PR3b (POST); the daily re-eval cron lands in PR3c.
 *
 * Auth: admin-only (shared requireAdmin → users.is_admin).
 * SoT: plans/id-block-corroboration-source-independence.md §4 + §5.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { ID_BLOCK_FLAG_KEY, loadIdBlockConfig } from "@/lib/parser/id-block/config";
import { buildQuarantineInventory, type QuarantineDbRow } from "@/lib/parser/id-block/inventory";

const LIVE_STATES = ["shadow", "held"];
const ALL_STATES = ["shadow", "held", "cleared", "promoted"];

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { supabase } = auth;

  const scope = req.nextUrl.searchParams.get("scope") === "all" ? "all" : "live";
  const states = scope === "all" ? ALL_STATES : LIVE_STATES;

  const [flagRes, cfg] = await Promise.all([
    supabase.from("feature_flag_rules").select("enabled").eq("flag_key", ID_BLOCK_FLAG_KEY).maybeSingle(),
    loadIdBlockConfig(supabase),
  ]);
  const flagEnabled = (flagRes.data as { enabled?: boolean } | null)?.enabled === true;

  const { data: rows, error } = await supabase
    .from("canonical_promotion_quarantine")
    .select("*")
    .in("state", states)
    .order("created_at", { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const inventory = await buildQuarantineInventory(
    supabase,
    (rows ?? []) as unknown as QuarantineDbRow[],
    cfg,
    flagEnabled,
  );
  return NextResponse.json(inventory);
}
