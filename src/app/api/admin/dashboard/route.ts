/**
 * GET /api/admin/dashboard — aggregate counts + top items across all admin tabs.
 *
 * Powers the /admin/dashboard To-Do Center. Returns per-section counts and a
 * short preview list so the admin can see at a glance what's pending.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { getAdminAuth } from "@/lib/firebase/admin";

async function verifyAdmin(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data } = await supabase
      .from("users")
      .select("id, is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (data?.is_admin !== true) return null;
    return { adminUserId: data.id };
  } catch {
    return null;
  }
}

async function safeCount(
  supabase: ReturnType<typeof createServerClient>,
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filter?: (q: any) => any,
): Promise<number> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base: any = supabase.from(table).select("id", { count: "exact", head: true });
    const query = filter ? filter(base) : base;
    const { count, error } = await query;
    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function safeFetch<T = any>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder: any,
): Promise<T[]> {
  try {
    const { data, error } = await builder;
    if (error) return [];
    return (data || []) as T[];
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const admin = await verifyAdmin(req);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const supabase = createServerClient();

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [
    correctionsPending,
    documentsUncategorized,
    documentsStuck,
    documentsFailed,
    documentsPendingReview,
    sbcTicketsOpen,
    supportTicketsOpen,
    insurancePlansNeedsReview,
    appealsProposedPending,
    costCapPaused,
    codeIdentityProposed,
    codeIdentityAmbiguous,
    planAcaInferred,
    subscriptionsPastDue,
    reviewQueuePending,
    discoveryPending,
    serviceNeedsCategory,
  ] = await Promise.all([
    safeCount(supabase, "benefit_corrections", (q) => q.eq("status", "pending")),
    safeCount(supabase, "documents", (q) =>
      q.eq("status", "processed").in("doc_type", ["uncategorized", "unknown"]),
    ),
    safeCount(supabase, "documents", (q) =>
      q.in("status", ["processing", "pending"]).lt("updated_at", oneDayAgo),
    ),
    safeCount(supabase, "documents", (q) => q.eq("status", "failed")),
    safeCount(supabase, "documents", (q) => q.eq("status", "pending_review")),
    safeCount(supabase, "sbc_tickets", (q) => q.in("status", ["open", "in_progress"])),
    safeCount(supabase, "support_tickets", (q) => q.in("status", ["open", "in_progress"])),
    safeCount(supabase, "insurance_plans", (q) => q.eq("verification_status", "unverified")),
    safeCount(supabase, "insurer_appeals_proposed_changes", (q) => q.eq("status", "pending")),
    // Cost-cap: users paused at the daily Haiku spend cap (haiku_spend_tracking.paused_at set).
    safeCount(supabase, "haiku_spend_tracking", (q) => q.not("paused_at", "is", null)),
    // Code identity: proposed billing-code identities + ambiguous 2-candidate ties.
    safeCount(supabase, "billing_code_identity", (q) => q.eq("promotion_state", "proposed")),
    safeCount(supabase, "code_identity_admin_review_queue", (q) => q.eq("status", "pending")),
    // Plans whose ACA-compliance flag was inferred (not attested) — need admin review.
    safeCount(supabase, "insurance_plans", (q) =>
      q.in("aca_compliance_basis", ["inferred_marketplace", "inferred_employer_post_2010", "unknown"]),
    ),
    safeCount(supabase, "stripe_customers", (q) => q.eq("subscription_status", "past_due")),
    // Benefit pipeline: proposed service slugs + insurer discovery + uncategorized services.
    safeCount(supabase, "service_catalog_admin_review_queue", (q) => q.eq("status", "pending")),
    safeCount(supabase, "insurer_discovery_queue", (q) => q.eq("status", "pending")),
    safeCount(supabase, "service_catalog", (q) => q.eq("category", "other")),
  ]);

  // Phase 7: pending disputes that are missing a plan for their claim year.
  // A dispute "needs plan" when its claim has a plan_year but the user has no
  // insurance_plans row with that year.
  const disputesNeedingPlan = await (async () => {
    try {
      const { data: rows } = await supabase
        .from("dispute_outcomes")
        .select("id, claim_id, dispute_type, created_at, user_id, claims!inner(plan_year, user_id)")
        .in("status", ["dispute_letter_drafted", "filed", "in_progress"])
        .order("created_at", { ascending: false })
        .limit(25);
      if (!rows) return [];
      const results: Array<{ id: string; claim_id: string; dispute_type: string; created_at: string; claim_year: number }> = [];
      for (const r of rows) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const claimRaw = (r as any).claims;
        const claim = Array.isArray(claimRaw) ? claimRaw[0] : claimRaw;
        const claimYear = claim?.plan_year ?? null;
        if (!claimYear) continue;
        const { data: plan } = await supabase
          .from("insurance_plans")
          .select("id")
          .eq("user_id", r.user_id)
          .eq("plan_year", claimYear)
          .limit(1)
          .maybeSingle();
        if (!plan) {
          results.push({
            id: r.id,
            claim_id: r.claim_id,
            dispute_type: r.dispute_type,
            created_at: r.created_at,
            claim_year: claimYear,
          });
        }
      }
      return results;
    } catch {
      return [];
    }
  })();
  const needsPlanCount = disputesNeedingPlan.length;

  // Top items for each section (up to 5 each)
  const [correctionsTop, documentsTop, supportTop] = await Promise.all([
    safeFetch(
      supabase
        .from("benefit_corrections")
        .select("id, service_slug, field, proposed_value, created_at")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(5),
    ),
    safeFetch(
      supabase
        .from("documents")
        .select("id, file_name, doc_type, status, created_at")
        .in("status", ["failed", "processing"])
        .order("created_at", { ascending: false })
        .limit(5),
    ),
    safeFetch(
      supabase
        .from("support_tickets")
        .select("id, subject, status, created_at")
        .in("status", ["open", "in_progress"])
        .order("created_at", { ascending: false })
        .limit(5),
    ),
  ]);

  return NextResponse.json({
    sections: [
      {
        key: "corrections",
        title: "Benefit Corrections",
        count: correctionsPending,
        href: "/admin/corrections",
        description: "User-submitted coverage corrections awaiting review.",
        items: correctionsTop,
      },
      {
        key: "documents_review",
        title: "Document Review",
        count: documentsPendingReview + documentsUncategorized + documentsFailed + documentsStuck,
        href: "/admin/documents/review",
        description: `${documentsPendingReview} pending review · ${documentsUncategorized} uncategorized · ${documentsFailed} failed · ${documentsStuck} stuck (>24h).`,
        items: documentsTop,
      },
      {
        key: "review_queue",
        title: "Review Queue",
        count: reviewQueuePending,
        href: "/admin/review-queue",
        description: "Parser-proposed service slugs awaiting promote / merge / reject.",
        items: [],
      },
      {
        key: "code_identity",
        title: "Code Identity",
        count: codeIdentityProposed + codeIdentityAmbiguous,
        href: "/admin/code-identity-review",
        description: `${codeIdentityProposed} proposed · ${codeIdentityAmbiguous} ambiguous ties to resolve.`,
        items: [],
      },
      {
        key: "insurer_appeals",
        title: "Insurer Appeals",
        count: appealsProposedPending,
        href: "/admin/insurer-appeals",
        description: "Proposed insurer appeals addresses awaiting admin review.",
        items: [],
      },
      {
        key: "disputes_missing_plan",
        title: "Disputes missing plan year",
        count: needsPlanCount,
        href: "/admin/claims#missing-plan-year",
        description: "Pending dispute letters where the claim's plan year has no matching user plan on file — letter is weaker without it.",
        items: disputesNeedingPlan.map((d) => ({
          id: d.id,
          claimId: d.claim_id,
          disputeType: d.dispute_type,
          needsPlanForYear: d.claim_year,
          created_at: d.created_at,
        })),
      },
      {
        key: "cost_cap",
        title: "Spend-capped users",
        count: costCapPaused,
        href: "/admin/cost-cap",
        description: "Users paused at the daily Haiku spend cap — unfreeze or set an override.",
        items: [],
      },
      {
        key: "plan_aca",
        title: "Plan ACA review",
        count: planAcaInferred,
        href: "/admin/plan-aca-overrides",
        description: "Plans with an inferred (not attested) ACA-compliance flag.",
        items: [],
      },
      {
        key: "sbc_tickets",
        title: "SBC Tickets",
        count: sbcTicketsOpen,
        href: "/admin/sbc-tickets",
        description: "User-reported issues with SBC extraction.",
        items: [],
      },
      {
        key: "support",
        title: "Support Tickets",
        count: supportTicketsOpen,
        href: "/admin/tickets",
        description: "Open support requests from users.",
        items: supportTop,
      },
      {
        key: "subscriptions_past_due",
        title: "Past-due subscriptions",
        count: subscriptionsPastDue,
        href: "/admin/subscriptions",
        description: "Stripe subscriptions in a past_due state.",
        items: [],
      },
      {
        key: "pipeline",
        title: "Benefit Pipeline",
        count: insurancePlansNeedsReview + discoveryPending + serviceNeedsCategory,
        href: "/admin/pipeline",
        description: `${insurancePlansNeedsReview} plans unverified · ${discoveryPending} insurers to triage · ${serviceNeedsCategory} services uncategorized.`,
        items: [],
      },
    ],
  });
}
