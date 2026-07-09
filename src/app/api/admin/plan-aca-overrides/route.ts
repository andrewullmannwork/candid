/**
 * GET /api/admin/plan-aca-overrides
 *
 * S74.6 §H.5 A5 — list users' insurance_plans rows where the ACA-compliance
 * flag was INFERRED (basis ∈ {inferred_marketplace, inferred_employer_post_2010,
 * unknown}). These are the highest-risk-of-inference-error plans — admin override
 * is the only mechanism (the plan-upload confirmation page UX was permanently
 * descoped per Subplan §1).
 *
 * POST /api/admin/plan-aca-overrides
 *
 * Body:
 *   {
 *     planId: string,
 *     isAcaCompliant: boolean,
 *     reason?: string,
 *   }
 *
 * Flips `insurance_plans.is_aca_compliant` for a specific user's plan and
 * sets `aca_compliance_basis='admin_override'` + `aca_compliance_source='admin'`
 * so downstream consumers know the value is admin-attested.
 *
 * Auth: Firebase bearer token + users.is_admin = true.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { logAdminAction } from "@/lib/admin/audit-log";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const supabase = createServerClient();

  // List inferred-basis plans for review. Newer first.
  const { data, error } = await supabase
    .from("insurance_plans")
    .select(
      "id, user_id, plan_name, insurer_name, plan_year, is_aca_compliant, aca_compliance_basis, aca_compliance_excerpt, aca_compliance_source, updated_at",
    )
    .in("aca_compliance_basis", [
      "inferred_marketplace",
      "inferred_employer_post_2010",
      "unknown",
    ])
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Hydrate user email.
  const userIds = Array.from(new Set((data ?? []).map((r) => r.user_id)));
  const { data: userRows } = await supabase
    .from("users")
    .select("id, email")
    .in("id", userIds);
  const userMap = new Map((userRows ?? []).map((u) => [u.id as string, u]));

  return NextResponse.json({
    plans: (data ?? []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      email: (userMap.get(r.user_id as string)?.email as string) ?? null,
      planName: r.plan_name,
      insurerName: r.insurer_name,
      planYear: r.plan_year,
      isAcaCompliant: r.is_aca_compliant,
      acaComplianceBasis: r.aca_compliance_basis,
      acaComplianceExcerpt: r.aca_compliance_excerpt,
      acaComplianceSource: r.aca_compliance_source,
      updatedAt: r.updated_at,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: {
    planId?: unknown;
    isAcaCompliant?: unknown;
    reason?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const planId = typeof body.planId === "string" ? body.planId : "";
  if (!planId || typeof body.isAcaCompliant !== "boolean") {
    return NextResponse.json(
      { error: "planId and isAcaCompliant (boolean) required" },
      { status: 400 },
    );
  }
  const reason =
    typeof body.reason === "string" ? body.reason.slice(0, 500) : "";

  const supabase = createServerClient();

  const { data: plan } = await supabase
    .from("insurance_plans")
    .select("id, user_id, plan_name, insurer_name, is_aca_compliant, aca_compliance_basis")
    .eq("id", planId)
    .maybeSingle();
  if (!plan) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  const { error: updateErr } = await supabase
    .from("insurance_plans")
    .update({
      is_aca_compliant: body.isAcaCompliant,
      aca_compliance_basis: "admin_override",
      aca_compliance_source: "admin",
      aca_compliance_excerpt: reason ? `Admin override: ${reason}` : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", planId);
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  await logAdminAction({
    adminUserId: auth.adminUserId,
    adminEmail: auth.adminEmail,
    action: "plan_aca_admin_override",
    targetTable: "insurance_plans",
    details: `Set is_aca_compliant=${body.isAcaCompliant} on plan ${planId} (${plan.plan_name ?? "?"} / ${plan.insurer_name ?? "?"}; was ${plan.is_aca_compliant} via ${plan.aca_compliance_basis})${reason ? `; reason="${reason}"` : ""}`,
  });

  return NextResponse.json({
    ok: true,
    planId,
    isAcaCompliant: body.isAcaCompliant,
    acaComplianceBasis: "admin_override",
  });
}
