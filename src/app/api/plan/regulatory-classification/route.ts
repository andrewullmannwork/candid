/**
 * /api/plan/regulatory-classification — S325 (PR-B, `forum_menu_v1`).
 *
 * The member's plan-level screening answers (coverage type + the regulator
 * their own documents name + the WA BBPA opt-in check), persisted as
 * insurance_plans.metadata.regulatory_classification. Plan-level BY DESIGN
 * (the S325 plan §1b flywheel ruling): the same classification the forum
 * router reads is what the DFY intake gates and the future parse enrichment
 * will read — one fact, one home, user-attested (`source: 'user_screening'`).
 *
 * GET  ?planId=<id>  → { classification, userState }
 *      planId optional: without it only profiles.state returns (the rail
 *      still needs the CA/WA gate before showing screening at all).
 * POST { planId, coverageType, caRegulator?, waBbpaOptedIn? } → { ok: true }
 *      Flag-gated server-side; read-merge-write on the metadata JSONB so
 *      sibling keys (eoc_* facts) are never clobbered.
 *
 * NOTE (batch-merge consolidation): profiles.state is read inline here; PR
 * #315 introduces `loadUserStateForLetterAccess` as the ONE state loader —
 * when the batch merges, this read consolidates onto it (same userScoped
 * read, one home).
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import type { CoverageType, CaRegulator, RegulatoryClassification } from "@/lib/disputes/forums";

const COVERAGE_TYPES: ReadonlySet<string> = new Set([
  "commercial_fully_insured",
  "employer_self_funded",
  "employer_self_funded_public",
  "medicare",
  "medicaid",
  "uninsured_self_pay",
]);
const CA_REGULATORS: ReadonlySet<string> = new Set(["DMHC", "CDI", "unknown"]);

async function authedUserId(req: NextRequest): Promise<string | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  let firebaseUid: string;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    firebaseUid = decoded.uid;
  } catch {
    return null;
  }
  const supabase = createServerClient();
  const { data: userRow } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", firebaseUid)
    .single();
  return (userRow?.id as string | undefined) ?? null;
}

export async function GET(req: NextRequest) {
  const userId = await authedUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = createServerClient();

  const { data: profile } = await userScoped(supabase, userId)
    .table("profiles")
    .select("state")
    .maybeSingle();
  const userState = (profile?.state as string | null) ?? null;

  const planId = req.nextUrl.searchParams.get("planId");
  if (!planId) return NextResponse.json({ classification: null, userState });

  const { data: plan, error } = await userScoped(supabase, userId)
    .table("insurance_plans")
    .select("metadata")
    .eq("id", planId)
    .maybeSingle();
  if (error) {
    console.error("[regulatory-classification] plan read failed:", error);
    return NextResponse.json({ classification: null, userState });
  }
  const classification =
    (((plan?.metadata as Record<string, unknown> | null)?.regulatory_classification ??
      null) as RegulatoryClassification | null);
  return NextResponse.json({ classification, userState });
}

export async function POST(req: NextRequest) {
  const userId = await authedUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isFeatureEnabled("forum_menu_v1"))) {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }

  let body: {
    planId?: unknown;
    coverageType?: unknown;
    caRegulator?: unknown;
    waBbpaOptedIn?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const planId = typeof body.planId === "string" ? body.planId : null;
  const coverageType =
    typeof body.coverageType === "string" && COVERAGE_TYPES.has(body.coverageType)
      ? (body.coverageType as CoverageType)
      : null;
  if (!planId || !coverageType) {
    return NextResponse.json({ error: "planId and a valid coverageType are required" }, { status: 400 });
  }
  const caRegulator =
    typeof body.caRegulator === "string" && CA_REGULATORS.has(body.caRegulator)
      ? (body.caRegulator as CaRegulator)
      : undefined;
  const waBbpaOptedIn = typeof body.waBbpaOptedIn === "boolean" ? body.waBbpaOptedIn : undefined;

  const supabase = createServerClient();
  // Read-merge-write: metadata carries sibling keys (eoc_* facts) that a
  // blind update would clobber.
  const { data: plan, error: readErr } = await userScoped(supabase, userId)
    .table("insurance_plans")
    .select("metadata")
    .eq("id", planId)
    .maybeSingle();
  if (readErr || !plan) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }
  const classification: RegulatoryClassification = {
    coverageType,
    ...(caRegulator ? { caRegulator } : {}),
    ...(waBbpaOptedIn !== undefined ? { waBbpaOptedIn } : {}),
    source: "user_screening",
    answeredAt: new Date().toISOString(),
  };
  const metadata = {
    ...((plan.metadata as Record<string, unknown> | null) ?? {}),
    regulatory_classification: classification,
  };
  const { error: writeErr } = await userScoped(supabase, userId)
    .table("insurance_plans")
    .update({ metadata })
    .eq("id", planId);
  if (writeErr) {
    console.error("[regulatory-classification] write failed:", writeErr);
    return NextResponse.json({ error: "Write failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, classification });
}
