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

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [
    correctionsPending,
    documentsUncategorized,
    documentsStuck,
    documentsFailed,
    sbcTicketsOpen,
    supportTicketsOpen,
    waitlistRecent,
    insurancePlansNeedsReview,
  ] = await Promise.all([
    safeCount(supabase, "benefit_corrections", (q) => q.eq("status", "pending")),
    safeCount(supabase, "documents", (q) =>
      q.eq("status", "processed").in("doc_type", ["uncategorized", "unknown"]),
    ),
    safeCount(supabase, "documents", (q) =>
      q.in("status", ["processing", "pending"]).lt("updated_at", oneDayAgo),
    ),
    safeCount(supabase, "documents", (q) => q.eq("status", "failed")),
    safeCount(supabase, "sbc_tickets", (q) => q.in("status", ["open", "in_progress"])),
    safeCount(supabase, "support_tickets", (q) => q.in("status", ["open", "in_progress"])),
    safeCount(supabase, "waitlist_signups", (q) => q.gte("created_at", sevenDaysAgo)),
    safeCount(supabase, "insurance_plans", (q) => q.eq("verification_status", "unverified")),
  ]);

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
        count: documentsUncategorized + documentsFailed + documentsStuck,
        href: "/admin/documents/review",
        description: `${documentsUncategorized} uncategorized · ${documentsFailed} failed · ${documentsStuck} stuck (>24h).`,
        items: documentsTop,
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
        key: "waitlist",
        title: "Waitlist Signups",
        count: waitlistRecent,
        href: "/admin/waitlist",
        description: "New signups in the last 7 days.",
        items: [],
      },
      {
        key: "plans_unverified",
        title: "Unverified Insurance Plans",
        count: insurancePlansNeedsReview,
        href: "/admin/pipeline",
        description: "Plans pending verification or CMS match.",
        items: [],
      },
    ],
  });
}
