/**
 * S70 — POST /api/plan/compare
 *
 * Body: { planRefs: Array<{ kind: "canonical" | "user_plan", id: string }> }
 *   Length must be 2-3 per Q-S70-1 LOCK A.
 *
 * Returns: { plans: ComparePlanPayload[] } in the order matching planRefs.
 *
 * Gates:
 *   1. Bearer-token auth (matches /api/plan/search pattern).
 *   2. `benefits_comparison_v1` feature flag must be ON for the user.
 *   3. Caller's email must be verified (carrot for verification per Q-S70-5).
 *   4. user_plan refs must be owned by the caller (defense in compare lib).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { loadDecorationContext } from "@/lib/plan/analyze-decoration";
import {
  resolveCanonicalPlan,
  resolveUserPlan,
  applyCompareSecondaryBackstop,
  type ComparePlanPayload,
  type PlanRef,
} from "@/lib/plan/compare";
import { attachBestForTags } from "@/lib/plan/best-for";

interface CompareRequestBody {
  planRefs?: unknown;
}

function parsePlanRefs(raw: unknown): PlanRef[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length < 2 || raw.length > 3) return null;
  const refs: PlanRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as { kind?: unknown; id?: unknown };
    if (typeof e.id !== "string" || e.id.length < 8) return null;
    if (e.kind !== "canonical" && e.kind !== "user_plan") return null;
    refs.push({ kind: e.kind, id: e.id });
  }
  return refs;
}

export async function POST(req: NextRequest) {
  // ── 1. Auth ────────────────────────────────────────────────────────────
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let decoded: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── 2. Feature flag ────────────────────────────────────────────────────
  const flagOn = await isFeatureEnabled("benefits_comparison_v1", decoded.email ?? undefined);
  if (!flagOn) {
    return NextResponse.json(
      { error: "Compare is not yet available." },
      { status: 503 },
    );
  }

  // ── 3. Email-verified gate (Q-S70-5 carrot) ────────────────────────────
  if (!decoded.email_verified) {
    return NextResponse.json(
      {
        error: "Verify your email to unlock Candid Compare.",
        code: "email_not_verified",
      },
      { status: 403 },
    );
  }

  // ── 4. Parse + validate body ───────────────────────────────────────────
  let body: CompareRequestBody;
  try {
    body = (await req.json()) as CompareRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const planRefs = parsePlanRefs(body.planRefs);
  if (!planRefs) {
    return NextResponse.json(
      { error: "planRefs must be an array of 2-3 { kind, id } refs" },
      { status: 400 },
    );
  }

  // ── 5. Resolve internal user (for IDOR check on user_plan refs) ────────
  const supabase = createServerClient();
  const { data: userRow } = await supabase
    .from("users")
    .select("id, email_verified")
    .eq("firebase_uid", decoded.uid)
    .single();
  if (!userRow) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  // Defense in depth: also enforce DB-side email_verified.
  if (!userRow.email_verified) {
    return NextResponse.json(
      {
        error: "Verify your email to unlock Candid Compare.",
        code: "email_not_verified",
      },
      { status: 403 },
    );
  }

  // ── 6. Build decoration context (Phase 4.0 consumer-read filter) ───────
  // Use the FIRST canonical-resolvable plan to seed canonicalSourceCount —
  // each plan re-derives its own count anyway via verification_count column;
  // pass null userPlan so loadDecorationContext skips the canonical query
  // and we'll populate per-plan in the resolvers.
  const decoration = await loadDecorationContext(supabase, decoded.email ?? null, null);

  // ── 7. Resolve each ref in parallel ────────────────────────────────────
  const resolved = await Promise.all(
    planRefs.map(async (ref): Promise<ComparePlanPayload | null> => {
      if (ref.kind === "canonical") {
        return resolveCanonicalPlan({
          supabase,
          canonicalPlanId: ref.id,
          decoration,
        });
      }
      return resolveUserPlan({
        supabase,
        insurancePlanId: ref.id,
        internalUserId: userRow.id,
        decoration,
      });
    }),
  );

  // S70.A — compute best-for tags relative to the resolved cohort (some
  // dimensions are relative, e.g., "lowest monthly cost" depends on peers).
  const successfullyResolved = resolved.filter((p): p is ComparePlanPayload => p !== null);
  attachBestForTags(successfullyResolved);

  // S161 (#1/#3) — preventive secondary backstop: fill "Not listed yet" cells
  // where a plan covers the service under a sibling slug (or via the ACA $0
  // floor). Gated by secondary_coverage_v2 (OFF → no-op). Runs AFTER best-for so
  // those tags stay grounded in enumerated coverage; it mutates the same payload
  // objects `resolved` holds (synthesized cells are inferred/estimate only).
  await applyCompareSecondaryBackstop(supabase, successfullyResolved);

  // Surface failed refs as nulls so UI can render "couldn't load" placeholder.
  return NextResponse.json({
    plans: resolved.map((p, i) => p ?? { ref: planRefs[i], error: "not_found" }),
  });
}
