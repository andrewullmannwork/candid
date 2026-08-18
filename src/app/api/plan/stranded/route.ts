/**
 * GET /api/plan/stranded — surface a fully-parsed plan document that never
 * became the user's active plan.
 *
 * WHY THIS EXISTS (S291, Andrew E2E):
 * `process-plan.ts` parks a parse whose plan identity diverges from what's on
 * file at `is_active=false` and hands the client an `insurerMismatch` payload,
 * EXPECTING a Keep/Switch prompt. `/upload` honours that contract;
 * `OnboardingDocStep` did not (it read only `pending_canonical_match`), so a
 * 33-service `document_verified` plan could sit inactive forever while `/plan`
 * kept rendering a 4-service card-derived one. The prompt is now wired in the
 * onboarding step, but that only helps NEW uploads — anyone already stranded
 * has no path back. This endpoint is that path.
 *
 * The detection is deliberately narrow — it targets exactly the users the bug
 * harmed, and self-clears without any new state:
 *   • the ACTIVE plan is weak provenance (card/manual, `unverified`), AND
 *   • an INACTIVE `document_verified` plan exists, AND
 *   • its source document carries NO `user_disambiguation` — i.e. the user was
 *     never actually asked.
 *
 * That last clause is the dismissal mechanism. Choosing "Keep my current plan"
 * (here or in onboarding) writes `record_disambiguation`, which permanently
 * drops the plan out of this query. No new column, no nag loop.
 *
 * Returns { plan: null } or
 * { plan: { insurancePlanId, documentId, planName, insurerName, serviceCount } }.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped, selectOwnedChildren } from "@/lib/security/user-scoped";

/** Provenance tiers that mean "we do NOT have this user's real plan document". */
const WEAK_PLAN_SOURCES = new Set(["insurance_card", "manual"]);

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let firebaseUid: string;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    firebaseUid = decoded.uid;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  const { data: userRow } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", firebaseUid)
    .single();
  if (!userRow) return NextResponse.json({ plan: null });

  const { data: profile } = await userScoped(supabase, userRow.id)
    .table("profiles")
    .select("active_insurance_plan_id")
    .single();
  const activeId = (profile?.active_insurance_plan_id as string | null) ?? null;

  // Gate 1 — only nag when what we're using is genuinely weaker than what's
  // sitting unused. A user whose active plan is already document-verified or
  // catalog-matched has nothing to recover.
  if (activeId) {
    const { data: activePlan, error: activeErr } = await userScoped(supabase, userRow.id)
      .table("insurance_plans")
      .select("source, verification_status")
      .eq("id", activeId)
      .maybeSingle();
    if (activeErr) {
      console.warn("[/api/plan/stranded] active plan read failed:", activeErr.message);
      return NextResponse.json({ plan: null });
    }
    const weak =
      WEAK_PLAN_SOURCES.has((activePlan?.source as string) ?? "") ||
      (activePlan?.verification_status as string) === "unverified";
    if (!weak) return NextResponse.json({ plan: null });
  }

  // Gate 2 — a document-verified plan the user isn't getting the benefit of.
  const { data: candidates, error: candErr } = await userScoped(supabase, userRow.id)
    .table("insurance_plans")
    .select("id, plan_name, insurer_name, created_at")
    .eq("is_active", false)
    .eq("verification_status", "document_verified")
    .order("created_at", { ascending: false })
    .limit(5);
  if (candErr) {
    console.warn("[/api/plan/stranded] candidate read failed:", candErr.message);
    return NextResponse.json({ plan: null });
  }
  if (!candidates?.length) return NextResponse.json({ plan: null });

  for (const cand of candidates) {
    if (cand.id === activeId) continue;

    // Gate 3 — the source document must exist (activation goes through its
    // documentId) and must not already carry the user's answer.
    const { data: doc, error: docErr } = await userScoped(supabase, userRow.id)
      .table("documents")
      .select("id, metadata")
      .eq("linked_insurance_plan_id", cand.id)
      .eq("status", "processed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (docErr) {
      console.warn("[/api/plan/stranded] document read failed:", docErr.message);
      continue;
    }
    if (!doc?.id) continue;

    const meta = (doc.metadata as Record<string, unknown> | null) ?? {};
    if (meta.user_disambiguation) continue; // already asked and answered

    // Gate 4 (S319, Andrew) — the user has MOVED ON: when two or more plans
    // entered the account after this candidate was parsed, offering the old
    // parse back is noise, not recovery ("I changed my plan twice since I
    // uploaded that document — silence it"). Counts NEW plan rows since the
    // candidate's created_at — deliberately not activation toggles between
    // old plans, which need an event source this banner doesn't warrant.
    // No new state: staleness self-derives, and a future re-parse of the
    // same document starts its own fresh count.
    const { data: newerPlans, error: newerErr } = await userScoped(supabase, userRow.id)
      .table("insurance_plans")
      .select("id")
      .neq("id", cand.id)
      .gt("created_at", cand.created_at as string)
      .limit(2);
    if (newerErr) {
      console.warn("[/api/plan/stranded] newer-plan count failed:", newerErr.message);
    } else if ((newerPlans?.length ?? 0) >= 2) {
      continue;
    }

    // plan_covered_services has no user_id — it's a parent-join child, so the
    // B1/B9 primitive (not userScoped().table()) is the sanctioned read.
    const services = await selectOwnedChildren(
      supabase,
      userRow.id,
      "plan_covered_services",
      [cand.id],
      "id",
    );

    return NextResponse.json({
      plan: {
        insurancePlanId: cand.id,
        documentId: doc.id,
        planName: (cand.plan_name as string | null) ?? null,
        insurerName: (cand.insurer_name as string | null) ?? null,
        serviceCount: services.length,
      },
    });
  }

  return NextResponse.json({ plan: null });
}
