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
 *   POST { id, action: 'confirm' | 'clear' | 'hold' }   (PR3b — per-cluster §4.3 action)
 *     · confirm/clear on a HELD row RELEASES the withheld doc-type promotion via the
 *       proper CF-40 mechanism (apply-confirmed-promotion.ts), bypassing the gate
 *       (admin override). On a SHADOW row they are a disposition only (already promoted).
 *     · hold keeps the current state + arms re-eval (next_eval_at → PR3c cron).
 *     Idempotent (disposed rows → no-op), state-guarded, non-fatal-audited.
 *
 * Auth: admin-only (shared requireAdmin → users.is_admin; admin_decided_by = users.id PK).
 * SoT: plans/id-block-corroboration-source-independence.md §4 + §5.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { ID_BLOCK_FLAG_KEY, loadIdBlockConfig } from "@/lib/parser/id-block/config";
import { buildQuarantineInventory, type QuarantineDbRow } from "@/lib/parser/id-block/inventory";
import {
  decideClusterActionEffect,
  type AdminAction,
  type QuarantineState,
} from "@/lib/parser/id-block/cluster-action";
import {
  applyAdminConfirmedPromotion,
  type ApplyConfirmedPromotionResult,
} from "@/lib/parser/cf40-v4/apply-confirmed-promotion";
import { logAdminAction } from "@/lib/admin/audit-log";

const LIVE_STATES = ["shadow", "held"];
const ALL_STATES = ["shadow", "held", "cleared", "promoted"];
const LIVE_STATE_SET = new Set<QuarantineState>(["shadow", "held"]);

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

/**
 * PR3b — per-cluster admin action (§4.3). confirm | clear | hold over a LIVE
 * (shadow|held) quarantine row. The action×state matrix is the pure
 * decideClusterActionEffect; the IO here re-applies a released held promotion FIRST
 * (fail-loud), then writes the disposition state-guarded, then audits.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { supabase, adminUserId } = auth;

  let body: { id?: string; action?: string };
  try {
    body = (await req.json()) as { id?: string; action?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { id } = body;
  const action = body.action;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (action !== "confirm" && action !== "clear" && action !== "hold") {
    return NextResponse.json(
      { error: "action must be one of confirm, clear, hold" },
      { status: 400 },
    );
  }
  const verifiedAction: AdminAction = action;

  // Load the target row.
  const { data: row, error: loadErr } = await supabase
    .from("canonical_promotion_quarantine")
    .select("id, canonical_plan_id, document_type, state, value_tuple_key")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "quarantine row not found" }, { status: 404 });

  const currentState = (row as { state: string }).state as QuarantineState;
  // Idempotent: only LIVE (shadow|held) rows are actionable; a disposed row → no-op.
  if (!LIVE_STATE_SET.has(currentState)) {
    return NextResponse.json({ ok: true, idempotent: true, state: currentState });
  }
  const canonicalPlanId = (row as { canonical_plan_id: string }).canonical_plan_id;
  const documentType = (row as { document_type: string }).document_type;
  const valueTupleKey = (row as { value_tuple_key: string }).value_tuple_key;

  const effect = decideClusterActionEffect(verifiedAction, currentState);

  // ── Re-apply the withheld promotion FIRST (G2 fail-loud ordering) ──
  let reapply: ApplyConfirmedPromotionResult | undefined;
  let finalState = effect.newState;
  if (effect.needsReApply) {
    try {
      // expectedTupleKey: promote ONLY the value this row was flagged for. If the
      // corroboration consensus drifted to a different tuple since the hold, refuse —
      // the admin would otherwise promote a value they didn't review (S176 guard).
      reapply = await applyAdminConfirmedPromotion(supabase, canonicalPlanId, documentType, {
        expectedTupleKey: valueTupleKey,
      });
    } catch (err) {
      console.error("[promotion-quarantine] re-apply threw:", err);
      return NextResponse.json(
        { error: "re-apply failed; row left held", reason: "exception" },
        { status: 500 },
      );
    }
    if (reapply.reason === "deferred_layer4") {
      // Layer-4 owns this canonical right now — leave the row held; admin resolves first.
      return NextResponse.json({
        ok: false,
        deferred: true,
        reason: reapply.reason,
        message:
          "Canonical is under Layer-4 adjudication (re-baseline/verification). Resolve it on /admin/canonical-quality, then retry.",
      });
    }
    if (reapply.reason === "tuple_drifted") {
      // The supermajority winner is no longer the value this row was flagged for — leave
      // it held; the admin re-reviews the current cluster (the new winner has its own row).
      return NextResponse.json({
        ok: false,
        deferred: true,
        reason: reapply.reason,
        message:
          "The corroboration consensus has shifted to a different value since this row was flagged. Re-review the current cluster before confirming/clearing.",
      });
    }
    if (reapply.reason === "write_failed") {
      return NextResponse.json(
        { error: "promotion write did not land; row left held", reason: reapply.reason },
        { status: 500 },
      );
    }
    // Nothing promotable (cluster gone / criteria no longer met / non-plan-doc): the
    // admin's verdict still resolves the flag, but record 'cleared' — never claim a
    // 'promoted' that did not happen.
    if (reapply.reason !== "promoted") finalState = "cleared";
  }

  const nowIso = new Date().toISOString();
  const update: Record<string, unknown> = {
    state: finalState,
    admin_decision: verifiedAction,
    admin_decided_at: nowIso,
    admin_decided_by: adminUserId, // users.id PK (requireAdmin)
    updated_at: nowIso,
  };
  if (effect.armsReEval) {
    // Hold → arm re-eval. PR3b sets initial eligibility (now); the PR3c daily cron owns
    // the recurring cadence and re-stamps next_eval_at per its config.
    update.next_eval_at = nowIso;
  }

  // State-guarded write (race-safe vs the live gate refresh + double-clicks).
  const { data: updated, error: updErr } = await supabase
    .from("canonical_promotion_quarantine")
    .update(update)
    .eq("id", id)
    .in("state", LIVE_STATES)
    .select("id")
    .maybeSingle();
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  if (!updated) {
    // Lost the race (disposed concurrently) — idempotent success.
    return NextResponse.json({ ok: true, idempotent: true, state: finalState });
  }

  // Forensic audit (Pattern 1 #10) — a Confirm can apply a canonical promotion. Non-fatal.
  try {
    const { data: adminRow } = await supabase
      .from("users")
      .select("email")
      .eq("id", adminUserId)
      .maybeSingle();
    const adminEmail = (adminRow as { email?: string } | null)?.email ?? adminUserId;
    await logAdminAction({
      adminUserId,
      adminEmail,
      action: `id_block_quarantine_${verifiedAction}`,
      targetTable: "canonical_promotion_quarantine",
      details: JSON.stringify({
        quarantineId: id,
        canonicalPlanId,
        documentType,
        fromState: currentState,
        toState: finalState,
        reapply: reapply ? { applied: reapply.applied, reason: reapply.reason } : null,
      }),
    });
  } catch (err) {
    console.warn("[promotion-quarantine] audit log failed (non-fatal):", err);
  }

  return NextResponse.json({
    ok: true,
    id,
    action: verifiedAction,
    fromState: currentState,
    newState: finalState,
    reapply: reapply
      ? { applied: reapply.applied, reason: reapply.reason, observed: reapply.observed }
      : null,
  });
}
