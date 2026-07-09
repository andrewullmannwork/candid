/**
 * POST /api/admin/code-identity/demote
 *
 * S74.6 §H.2 A2 — admin demotes a `billing_code_identity` row back to
 * `promotion_state='proposed'`. Used when downstream evidence contradicts an
 * admin-seeded or admin-verified row (e.g., the seed slug turned out wrong
 * after real-user votes disagreed).
 *
 * Effect:
 *   - promotion_state flips to 'proposed' (admin-attested status revoked)
 *   - last_promotion_event_at bumps so downstream re-audits pick up the change
 *   - admin notes captured for audit trail
 *
 * Does NOT delete corroborator_sources entries or reset distinct_user_count —
 * the historical votes/observations are preserved for forensics. Admin can
 * re-promote later if evidence converges differently.
 *
 * Body:
 *   {
 *     identityId: string,
 *     reason?: string,
 *   }
 *
 * Auth: Firebase bearer token + users.is_admin = true.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { logAdminAction } from "@/lib/admin/audit-log";

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { identityId?: unknown; reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const identityId =
    typeof body.identityId === "string" ? body.identityId : "";
  const reason =
    typeof body.reason === "string" ? body.reason.slice(0, 500) : "";
  if (!identityId) {
    return NextResponse.json({ error: "identityId required" }, { status: 400 });
  }

  const supabase = createServerClient();

  const { data: identity } = await supabase
    .from("billing_code_identity")
    .select("id, billing_code, billing_code_type, promotion_state, service_slug")
    .eq("id", identityId)
    .maybeSingle();
  if (!identity) {
    return NextResponse.json(
      { error: "Identity row not found" },
      { status: 404 },
    );
  }
  if (
    identity.promotion_state !== "corroborated" &&
    identity.promotion_state !== "admin_verified"
  ) {
    return NextResponse.json(
      {
        error: `Cannot demote a row in '${identity.promotion_state}' state; only corroborated or admin_verified rows can be demoted.`,
      },
      { status: 400 },
    );
  }

  const { error: updateErr } = await supabase
    .from("billing_code_identity")
    .update({
      promotion_state: "proposed",
      last_promotion_event_at: new Date().toISOString(),
    })
    .eq("id", identityId);
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  await logAdminAction({
    adminUserId: auth.adminUserId,
    adminEmail: auth.adminEmail,
    action: "code_identity_demoted",
    targetTable: "billing_code_identity",
    details: `Demoted ${identityId} (${identity.billing_code}/${identity.billing_code_type}, slug=${identity.service_slug ?? "<unset>"}) from ${identity.promotion_state} to proposed${reason ? `; reason="${reason}"` : ""}`,
  });

  return NextResponse.json({
    ok: true,
    identityId,
    fromState: identity.promotion_state,
    toState: "proposed",
  });
}
