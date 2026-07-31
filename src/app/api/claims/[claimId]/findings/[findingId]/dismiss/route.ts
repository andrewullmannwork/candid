/**
 * POST /api/claims/[claimId]/findings/[findingId]/dismiss
 *
 * S74.5 D15 Q-E LOCK — per-finding dismiss-with-reason endpoint.
 *
 * Findings live inside claim_line_items.metadata.auditFindings (an array of
 * objects). This endpoint marks one finding (by its id within that array)
 * as dismissed, attaching the reason + dismissed_at timestamp. Dismissed
 * findings are filtered out of the default /claim findings list; reason
 * corpus is preserved for flywheel telemetry (false-positive pattern
 * detection / future Pattern P-9 promotion candidates).
 *
 * Body:
 *   {
 *     reason: "legitimate_adjustment" | "prior_balance_carryover" |
 *             "prompt_pay_discount" | "state_mandate_adjustment" | "other",
 *     note?: string  (free text; required when reason === "other")
 *   }
 *
 * Auth: Firebase bearer token; verifies user owns the claim.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { userScoped, selectOwnedChildren, updateOwnedChildren } from "@/lib/security/user-scoped";
import { emitCaseEvent } from "@/lib/case/case-events";

const VALID_REASONS = new Set([
  "legitimate_adjustment",
  "prior_balance_carryover",
  "prompt_pay_discount",
  "state_mandate_adjustment",
  "other",
]);

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string; findingId: string }> },
) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const flywheelEnabled = await isFeatureEnabled(
    "s74_5_categorization_flywheel_v1",
  );
  if (!flywheelEnabled) {
    return NextResponse.json({ error: "Feature not enabled" }, { status: 404 });
  }

  const { claimId, findingId } = await params;

  let body: { reason?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const reason = typeof body.reason === "string" ? body.reason : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!VALID_REASONS.has(reason)) {
    return NextResponse.json(
      { error: `reason must be one of: ${Array.from(VALID_REASONS).join(", ")}` },
      { status: 400 },
    );
  }
  if (reason === "other" && !note) {
    return NextResponse.json(
      { error: "Free-text note is required when reason is 'other'" },
      { status: 400 },
    );
  }

  const supabase = createServerClient();

  // Resolve user_id from Firebase UID + verify claim ownership
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // B9 B1.2 — userScoped injects `.eq("user_id")`; foreign/missing claimId →
  // null → 404. The JS owner check stays (harmless; unreachable for the owner).
  const { data: claim } = await userScoped(supabase, user.id)
    .table("claims")
    .select("id, user_id, metadata")
    .eq("id", claimId)
    .single();
  if (!claim || claim.user_id !== user.id) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  // Findings can live in three places:
  //   1. claim_line_items.metadata.auditFindings — line-level (per-line audit rules)
  //   2. claim_line_items.metadata.auditFindings on multiple lines — multi-line finding
  //   3. claim.metadata.auditSummary.claimLevelFindings — claim-header findings (§1.7)
  // Walk all three; touch every match.
  // B9 B1.2 — claim_line_items has no user_id; selectOwnedChildren verifies the
  // parent claim is owned (claimId verified above) then returns its lines.
  const lineItems = await selectOwnedChildren(
    supabase,
    user.id,
    "claim_line_items",
    [claimId],
    "id, line_number, metadata",
  );

  let touched = 0;
  const dismissedAt = new Date().toISOString();
  // Telemetry capture: track which finding (type + amount + line_number) was dismissed
  // for the finding_dismissals table write below.
  let touchedFindingType: string | null = null;
  let touchedFindingAmount: number | null = null;
  // S74.5c C-5 — multi-line findings (e.g., duplicate detection spanning
  // lines 2 + 3) dismiss on EVERY line they appear. Track all line numbers
  // touched; for the telemetry table write below, NULL means "spans multiple
  // lines" so analytics queries don't have to GROUP-BY the last-iterated line.
  const touchedLineNumbers: number[] = [];

  // Pass 1 — line-level findings. B9 B1.2 — collect each matched line's metadata
  // update, then apply them in ONE parent-scoped child write below (claimId
  // proven owned above). Op-equivalent to the prior per-line loop: every line
  // came from the owned claim, so each update lands → updated === #matched.
  const lineUpdates: { id: string; values: Record<string, unknown> }[] = [];
  for (const li of lineItems ?? []) {
    const meta = (li.metadata as Record<string, unknown> | null) ?? {};
    const findings =
      (meta.auditFindings as Array<Record<string, unknown>> | undefined) ?? [];
    let mutated = false;
    const next = findings.map((f) => {
      if (f.id !== findingId) return f;
      mutated = true;
      touchedFindingType = String(f.type ?? "unknown");
      touchedFindingAmount = Number(f.estimatedOvercharge ?? 0);
      return {
        ...f,
        dismissed: true,
        dismissed_at: dismissedAt,
        dismissed_reason: reason,
        dismissed_note: note || null,
      };
    });
    if (!mutated) continue;
    touchedLineNumbers.push(li.line_number as number);
    lineUpdates.push({
      id: li.id as string,
      values: { metadata: { ...meta, auditFindings: next } },
    });
  }
  if (lineUpdates.length > 0) {
    const { updated } = await updateOwnedChildren(
      supabase,
      user.id,
      "claim_line_items",
      claimId,
      lineUpdates,
    );
    touched += updated;
  }
  // C-5 — single-line: store the one line_number. Multi-line: NULL — telemetry
  // analytics treat NULL as "span" (vs claim-level which is also NULL but has
  // finding_type explicitly claim-header). Disambiguation via finding_type.
  const touchedFindingLineNumber: number | null =
    touchedLineNumbers.length === 1 ? touchedLineNumbers[0] : null;

  // Pass 2 — claim-level findings (§1.7)
  if (touched === 0) {
    const claimMeta = (claim.metadata as Record<string, unknown> | null) ?? {};
    const auditSummary =
      (claimMeta.auditSummary as
        | { claimLevelFindings?: Array<Record<string, unknown>> }
        | null
        | undefined) ?? null;
    const claimLevel =
      (auditSummary?.claimLevelFindings as Array<Record<string, unknown>> | undefined) ??
      [];
    let mutated = false;
    const next = claimLevel.map((f) => {
      if (f.id !== findingId) return f;
      mutated = true;
      touchedFindingType = String(f.type ?? "unknown");
      touchedFindingAmount = Number(f.estimatedOvercharge ?? 0);
      // line_number stays null for claim-level findings — already correct in
      // touchedFindingLineNumber default + the C-5 single/multi-line branch
      // doesn't fire since we never push to touchedLineNumbers here.
      return {
        ...f,
        dismissed: true,
        dismissed_at: dismissedAt,
        dismissed_reason: reason,
        dismissed_note: note || null,
      };
    });
    if (mutated) {
      await userScoped(supabase, user.id)
        .table("claims")
        .update({
          metadata: {
            ...claimMeta,
            auditSummary: {
              ...(auditSummary ?? {}),
              claimLevelFindings: next,
            },
          },
        })
        .eq("id", claimId);
      touched += 1;
    }
  }

  if (touched === 0) {
    return NextResponse.json({ error: "Finding not found" }, { status: 404 });
  }

  // §3.12 — durable telemetry insert. Non-fatal: dismiss is the user-visible
  // action and must succeed even if the telemetry write fails (table may not
  // exist on pre-mig-091 DBs).
  try {
    // B9 B1.2 — finding_dismissals is a direct user_id table; userScoped.insert
    // stamps user_id (drop the explicit field — the layer overrides it anyway).
    await userScoped(supabase, user.id).table("finding_dismissals").insert({
      claim_id: claimId,
      finding_id: findingId,
      finding_type: touchedFindingType,
      finding_amount: touchedFindingAmount,
      finding_line_number: touchedFindingLineNumber,
      reason,
      note: note || null,
    });
  } catch (err) {
    console.warn(
      "[finding-dismiss] finding_dismissals insert failed (non-fatal)",
      err,
    );
  }

  // Structured log alongside the table (preserved for log-stream-only deploys).
  console.log("[finding-dismiss] dismissed", {
    claimId,
    findingId,
    userId: user.id,
    findingType: touchedFindingType,
    findingAmount: touchedFindingAmount,
    findingLineNumber: touchedFindingLineNumber,
    reason,
    hasNote: note.length > 0,
    touchedLines: touched,
    dismissedAt,
  });

  // Timeline unification Phase 0 (S298, mig 221) — the user's judgment on our
  // finding, in sequence (the precision oracle). References only: type,
  // reason enum, finding id — the amount stays in finding_dismissals.
  await emitCaseEvent(supabase, user.id, {
    claimId,
    kind: "finding_dismissed",
    payload: {
      findingId,
      findingType: touchedFindingType,
      reason,
      hasNote: note.length > 0,
    },
  });

  return NextResponse.json({ ok: true, touched, dismissedAt });
}
