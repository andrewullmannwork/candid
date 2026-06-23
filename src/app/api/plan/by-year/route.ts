/**
 * GET /api/plan/by-year?year=YYYY[&pin=<insurance_plan_id>]
 *
 * Returns the caller's own insurance plans for a single plan year, for the
 * mid-year-plan-change dispute chooser (dispute_plan_pinning_v1, Phase 2).
 *
 * Scoped by plan_year so the result stays bounded on heavy accounts — the
 * unscoped insurance_plans fetch is PostgREST-capped at 1000 rows, which would
 * silently truncate (and a real user has only a handful of plans per year).
 *
 * `pin` (optional) = the claim's current pin (claims.insurance_plan_id). It is
 * guaranteed to appear in the result even if it sits in a different plan_year or
 * outside the bounded year query — fetched directly by id, user-scoped — so the
 * chooser can always pre-select the current pin. Mirrors the resolver's own
 * truncation-proof pin fetch (plan-context.ts).
 *
 * User-scoped (Pattern 1 #14 / B1): userScoped injects .eq("user_id"); a `pin`
 * that isn't the caller's simply returns no row (no IDOR).
 *
 * Returns: { plans: [{ insurancePlanId, planName, insurerName, planType,
 *           planYear, coveragePeriodStart, coveragePeriodEnd, isActive }] }
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/security/require-authenticated-user";
import { userScoped } from "@/lib/security/user-scoped";

const PLAN_COLUMNS =
  "id, plan_name, insurer_name, plan_type, plan_year, coverage_period_start, coverage_period_end, is_active";

interface PlanRow {
  id: string;
  plan_name: string | null;
  insurer_name: string | null;
  plan_type: string | null;
  plan_year: number | null;
  coverage_period_start: string | null;
  coverage_period_end: string | null;
  is_active: boolean | null;
}

function toPlan(row: PlanRow) {
  return {
    insurancePlanId: row.id,
    planName: row.plan_name,
    insurerName: row.insurer_name,
    planType: row.plan_type,
    planYear: row.plan_year,
    coveragePeriodStart: row.coverage_period_start,
    coveragePeriodEnd: row.coverage_period_end,
    isActive: row.is_active === true,
  };
}

export async function GET(req: NextRequest) {
  const authedUser = await requireAuthenticatedUser(req);
  if (!authedUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const yearParam = req.nextUrl.searchParams.get("year");
  const year = yearParam ? parseInt(yearParam, 10) : NaN;
  if (!Number.isInteger(year)) {
    return NextResponse.json(
      { error: "A valid `year` query param is required" },
      { status: 400 },
    );
  }
  const pin = req.nextUrl.searchParams.get("pin");

  const supabase = createServerClient();

  const { data: yearRows, error } = await userScoped(supabase, authedUser.id)
    .table("insurance_plans")
    .select(PLAN_COLUMNS)
    .eq("plan_year", year)
    .order("created_at", { ascending: false });

  if (error) {
    console.warn("[/api/plan/by-year] select error:", error.message);
    return NextResponse.json({ plans: [] });
  }

  const rows = (yearRows ?? []) as PlanRow[];

  // Guarantee the claim's current pin is selectable even if it sits in another
  // plan_year or outside the bounded year query. Direct, user-scoped by-id fetch.
  if (pin && !rows.some((r) => r.id === pin)) {
    const { data: pinRow } = await userScoped(supabase, authedUser.id)
      .table("insurance_plans")
      .select(PLAN_COLUMNS)
      .eq("id", pin)
      .maybeSingle();
    if (pinRow) rows.unshift(pinRow as PlanRow);
  }

  return NextResponse.json({ plans: rows.map(toPlan) });
}
