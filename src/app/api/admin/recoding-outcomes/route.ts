/**
 * GET /api/admin/recoding-outcomes
 *
 * S74.6 §H.3 A3 — list dispute_outcomes rows where the insurer reprocessed
 * the claim under a different code (recoded_as_code IS NOT NULL). Groups by
 * `(recoded_as_code, recoded_as_code_type)` so admins see "this alt-code has
 * surfaced N times across M users." Each group exposes the per-row dispute
 * detail (recovered_amount + claim id) so admins can drill into the underlying
 * dispute when reviewing.
 *
 * POST /api/admin/recoding-outcomes
 *
 * Body:
 *   {
 *     recodedAsCode: string,
 *     recodedAsCodeType: string,
 *     doNotSurface: boolean,
 *   }
 *
 * Toggles `billing_code_identity.do_not_surface_in_letters` for every row
 * matching `(billing_code=recodedAsCode, billing_code_type=recodedAsCodeType)`.
 * When TRUE, peer-code-engine excludes these identities from dispute-letter
 * alternative-code recommendations. Reversible — admin can re-enable.
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

  const { data: rows, error } = await supabase
    .from("dispute_outcomes")
    .select(
      "id, claim_id, user_id, status, recoded_as_code, recoded_as_code_type, recovered_amount, created_at",
    )
    .not("recoded_as_code", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Group by (recoded_as_code, recoded_as_code_type).
  type GroupRow = {
    recodedAsCode: string;
    recodedAsCodeType: string;
    winCount: number;
    totalRecovered: number;
    distinctUsers: Set<string>;
    distinctClaims: Set<string>;
    latestAt: string;
    doNotSurface: boolean;
  };
  const groups = new Map<string, GroupRow>();
  for (const r of rows ?? []) {
    const code = r.recoded_as_code as string;
    const codeType = (r.recoded_as_code_type as string) ?? "";
    const key = `${code}||${codeType}`;
    const prior = groups.get(key);
    const recovered = Number(r.recovered_amount ?? 0);
    const wonish =
      r.status === "won" ||
      r.status === "won_on_escalation" ||
      r.status === "settled";
    if (!prior) {
      groups.set(key, {
        recodedAsCode: code,
        recodedAsCodeType: codeType,
        winCount: wonish ? 1 : 0,
        totalRecovered: wonish ? recovered : 0,
        distinctUsers: new Set([r.user_id as string]),
        distinctClaims: r.claim_id ? new Set([r.claim_id as string]) : new Set(),
        latestAt: r.created_at as string,
        doNotSurface: false,
      });
    } else {
      if (wonish) {
        prior.winCount += 1;
        prior.totalRecovered += recovered;
      }
      prior.distinctUsers.add(r.user_id as string);
      if (r.claim_id) prior.distinctClaims.add(r.claim_id as string);
    }
  }

  // For each group, look up the do_not_surface flag on billing_code_identity.
  // Group keys aren't perfect — billing_code_identity also has
  // description_signature dimension — so we fetch ALL identity rows matching
  // (code, code_type) and use ANY-row-flagged as the group answer.
  if (groups.size > 0) {
    const codes = Array.from(groups.values()).map((g) => g.recodedAsCode);
    const codeTypes = Array.from(groups.values()).map((g) => g.recodedAsCodeType);
    const { data: identityRows } = await supabase
      .from("billing_code_identity")
      .select("billing_code, billing_code_type, do_not_surface_in_letters")
      .in("billing_code", codes)
      .in("billing_code_type", codeTypes);
    for (const ir of identityRows ?? []) {
      const key = `${ir.billing_code}||${ir.billing_code_type}`;
      const g = groups.get(key);
      if (g && ir.do_not_surface_in_letters === true) {
        g.doNotSurface = true;
      }
    }
  }

  return NextResponse.json({
    groups: Array.from(groups.values()).map((g) => ({
      recodedAsCode: g.recodedAsCode,
      recodedAsCodeType: g.recodedAsCodeType,
      winCount: g.winCount,
      totalRecovered: g.totalRecovered,
      distinctUsers: g.distinctUsers.size,
      distinctClaims: g.distinctClaims.size,
      latestAt: g.latestAt,
      doNotSurface: g.doNotSurface,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: {
    recodedAsCode?: unknown;
    recodedAsCodeType?: unknown;
    doNotSurface?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const code =
    typeof body.recodedAsCode === "string" ? body.recodedAsCode.trim() : "";
  const codeType =
    typeof body.recodedAsCodeType === "string"
      ? body.recodedAsCodeType.trim()
      : "";
  const doNotSurface = body.doNotSurface === true;
  if (!code || !codeType) {
    return NextResponse.json(
      { error: "recodedAsCode and recodedAsCodeType required" },
      { status: 400 },
    );
  }

  const supabase = createServerClient();

  const { error: updateErr, data: updatedRows } = await supabase
    .from("billing_code_identity")
    .update({ do_not_surface_in_letters: doNotSurface })
    .eq("billing_code", code)
    .eq("billing_code_type", codeType)
    .select("id");
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }
  const updatedRowCount = updatedRows?.length ?? 0;

  await logAdminAction({
    adminUserId: auth.adminUserId,
    adminEmail: auth.adminEmail,
    action: doNotSurface
      ? "recoding_pattern_suppressed"
      : "recoding_pattern_unsuppressed",
    targetTable: "billing_code_identity",
    details: `Toggled do_not_surface_in_letters=${doNotSurface} for ${code}/${codeType} (${updatedRowCount} identity rows updated)`,
  });

  return NextResponse.json({
    ok: true,
    recodedAsCode: code,
    recodedAsCodeType: codeType,
    doNotSurface,
    updatedRowCount,
  });
}
