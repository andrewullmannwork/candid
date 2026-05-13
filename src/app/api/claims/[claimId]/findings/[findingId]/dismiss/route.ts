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

  const { data: claim } = await supabase
    .from("claims")
    .select("id, user_id")
    .eq("id", claimId)
    .single();
  if (!claim || claim.user_id !== user.id) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  // Findings can live on multiple line items if the audit finding spans
  // multiple lines (rare but possible for claim-header findings). Update
  // every line item that has this finding in its metadata.
  const { data: lineItems } = await supabase
    .from("claim_line_items")
    .select("id, metadata")
    .eq("claim_id", claimId);

  if (!lineItems || lineItems.length === 0) {
    return NextResponse.json({ error: "No line items found" }, { status: 404 });
  }

  let touched = 0;
  const dismissedAt = new Date().toISOString();
  for (const li of lineItems) {
    const meta = (li.metadata as Record<string, unknown> | null) ?? {};
    const findings =
      (meta.auditFindings as Array<Record<string, unknown>> | undefined) ?? [];
    let mutated = false;
    const next = findings.map((f) => {
      if (f.id !== findingId) return f;
      mutated = true;
      return {
        ...f,
        dismissed: true,
        dismissed_at: dismissedAt,
        dismissed_reason: reason,
        dismissed_note: note || null,
      };
    });
    if (!mutated) continue;
    await supabase
      .from("claim_line_items")
      .update({ metadata: { ...meta, auditFindings: next } })
      .eq("id", li.id);
    touched += 1;
  }

  if (touched === 0) {
    return NextResponse.json({ error: "Finding not found" }, { status: 404 });
  }

  // Telemetry log line for downstream analysis (Pattern P-9 candidate).
  // Dedicated table is a follow-up — for v1, structured logging is enough.
  console.log("[finding-dismiss] dismissed", {
    claimId,
    findingId,
    userId: user.id,
    reason,
    hasNote: note.length > 0,
    touchedLines: touched,
    dismissedAt,
  });

  return NextResponse.json({ ok: true, touched, dismissedAt });
}
