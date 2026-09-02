/**
 * GET /api/admin/dfy/queue — the operator's matter queue + intake list (S330).
 *
 * Cross-member by role authority (unclaimed matters are visible to every
 * operator); every member-owned read inside the summaries goes through the
 * member's own ownership. Returns the operator's load against the config cap,
 * the config the page renders (threshold, IP policy), matters, and applicants.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOperator } from "@/lib/admin/require-operator";
import { listEngagementsForOperators, countHeldMatters } from "@/lib/security/operator-scoped";
import { CAP_COUNTED_STATUSES } from "@/lib/dfy/engagement-state";
import { loadMatterSummary, loadUsersDisplay } from "@/lib/dfy/matter";
import { operatorErrorResponse } from "@/lib/dfy/operator-action";

export async function GET(req: NextRequest) {
  const auth = await requireOperator(req);
  if (!auth.ok) return auth.response;
  const { supabase, operatorUserId, operatorEmail, role, config, ip } = auth;
  try {
    const [engagements, held] = await Promise.all([
      listEngagementsForOperators(supabase, operatorUserId),
      countHeldMatters(supabase, operatorUserId, CAP_COUNTED_STATUSES),
    ]);
    const ids = engagements.flatMap((e) => [e.user_id, ...(e.operator_user_id ? [e.operator_user_id] : [])]);
    const users = await loadUsersDisplay(supabase, ids);
    const now = new Date();
    const summaries = await Promise.all(engagements.map((e) => loadMatterSummary(supabase, e, { now, users })));
    const applicants = summaries.filter((m) => m.engagement.status === "eligibility_pending");
    const matters = summaries.filter((m) => m.engagement.status !== "eligibility_pending");
    return NextResponse.json({
      operator: { userId: operatorUserId, email: operatorEmail, role, held, cap: config.concurrentCap, ip },
      config: {
        refusalRunwayBusinessDays: config.refusalRunwayBusinessDays,
        ipAllowlistEnforced: config.ipAllowlistEnforced,
        ipAllowlistSize: config.ipAllowlist.length,
        marketingGateVerifiedOn: config.marketingGateVerifiedOn,
      },
      matters,
      applicants,
    });
  } catch (err) {
    const { status, body } = operatorErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
