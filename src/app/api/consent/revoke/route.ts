import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";

// S199 — withdrawing health-data consent is a FULL erasure of the user's
// consumer health data and their own insurance-plan rows (it leaves the account
// open; account deletion additionally removes the account).
//
// Deleted, dependents-first so an inter-table FK never blocks a delete. The two
// no-user_id children (`claim_line_items` ← `claims`, `plan_covered_services` ←
// `insurance_plans`) carry no user_id and are therefore reachable ONLY via their
// parent's `ON DELETE CASCADE` — the same path account deletion relies on — so
// deleting the parents below removes them too.
//
// KEPT — account-level (the account survives revoke): `profiles`,
// `stripe_customers`, `consent_events` (this holds the revocation record
// itself), `subscription_events`, `support_tickets`.
// KEPT — de-linked operational carve-out (disclosed in the policy): cost/usage
// telemetry (`parse_cost_events`, `haiku_*`, `bill_parser_decisions`,
// `document_extraction_log`).
// KEPT — de-identified, generic plan catalog (`canonical_plans` /
// `canonical_plan_services`, no user_id): never touched.
const CHD_DELETE_ORDER = [
  "dispute_followups",
  "dispute_outcomes",
  "claim_discrepancies",
  "benefit_corrections",
  "finding_dismissals",
  "insurer_appeals_confirmations",
  "compare_premium_observations",
  "claims", // CASCADE removes claim_line_items
  "insurance_plans", // CASCADE removes plan_covered_services
] as const;

// Non-terminal dispute statuses (mig 043 lifecycle vocab) — an "active" dispute
// the user may not want to lose. The Settings modal warns before confirming.
const ACTIVE_DISPUTE_STATUSES = [
  "filed",
  "in_progress",
  "dispute_letter_drafted",
  "court_documentation_drafted",
];

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const idToken = authHeader.slice(7);
    const decoded = await getAdminAuth().verifyIdToken(idToken);
    const supabase = createServerClient();

    const { data: user } = await supabase
      .from("users")
      .select("id")
      .eq("firebase_uid", decoded.uid)
      .single();

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const { consentType, confirm } = await req.json();

    // Only the health-data consent has a data-deletion side effect.
    if (consentType !== "health_data_upload") {
      return NextResponse.json({ success: true });
    }

    // Count active (non-terminal) disputes that erasure would destroy, so the UI
    // can warn the user before they confirm.
    const { data: activeDisputes } = await userScoped(supabase, user.id)
      .table("dispute_outcomes")
      .select("id")
      .in("status", ACTIVE_DISPUTE_STATUSES);
    const activeDisputeCount = activeDisputes?.length ?? 0;

    // Phase 1 (no `confirm`): report impact, delete nothing. The Settings modal
    // calls this to build its warning; the destructive call passes confirm:true.
    if (confirm !== true) {
      return NextResponse.json({ requiresConfirmation: true, activeDisputeCount });
    }

    // Phase 2 (confirmed): full erasure of the user's CHD + plan rows.
    // 1. Remove uploaded files from storage, then the document rows.
    const { data: docs } = await userScoped(supabase, user.id)
      .table("documents")
      .select("id, storage_path");
    if (docs && docs.length > 0) {
      await supabase.storage
        .from("documents")
        .remove(docs.map((d) => d.storage_path as string));
    }
    await userScoped(supabase, user.id).table("documents").delete();

    // 2. Delete the CHD + plan tables (dependents first; children cascade).
    for (const table of CHD_DELETE_ORDER) {
      await userScoped(supabase, user.id).table(table).delete();
    }

    // 3. canonical_haiku_extractions — per-user raw extraction store, user-linked,
    //    so deleted per "keep only the generic plan catalog, nothing specific to
    //    you." It is NOT in the userScoped registry (parser-written / admin-read),
    //    so the ownership filter is applied explicitly here.
    await supabase
      .from("canonical_haiku_extractions")
      .delete()
      .eq("user_id", user.id);

    return NextResponse.json({ success: true, activeDisputeCount });
  } catch (error) {
    console.error("Consent revocation error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
