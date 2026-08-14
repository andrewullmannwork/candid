/**
 * POST /api/plan/identity-answer — S313: the member answers the plan-identity
 * question our own resolver could not.
 *
 * WHY IT EXISTS. `decideAccumulatorCarry` returns a THREE-way verdict —
 * carry / exclude / ask — and `ask` means exactly one thing: the canonical pair
 * could not tell us whether the member's other-year plan row is the same
 * coverage as this one. The plan-change ask on /plan surfaces that question.
 * Until now the member's answer was thrown away: "Keep on the old plan" wrote
 * nothing, so the bills stayed in `sameYearAsk` and the ask returned forever.
 *
 * The answer is a fact about a PAIR OF PLANS, not about a bill. Bill-scoped
 * storage would re-ask for the next bill that arrives on the same old plan —
 * a nag that never ends. One answer per pair covers every bill on it, now and
 * later.
 *
 * WHERE IT LIVES. `insurance_plans.metadata.planIdentityAnswers[<otherPlanId>]`
 * on the CURRENT plan (Rule #9 JSONB-first — one map does not earn a table, and
 * Rule #1 forbids a duplicate entity table). User-scoped only: this is the
 * member's assertion about their own two rows and never touches canonical
 * (Rule #10 — user-initiated events write user-scoped; canonical moves only by
 * an explicit promotion event).
 *
 * THE RESET DISCIPLINE. The stored answer records BOTH plans' canonical ids as
 * they stood when it was given. A reader honours the answer only while both
 * still match. That is the same lesson `wrongYearBannerDismissed` learned (it
 * resets on every re-bind): an answer to "are these the same plan?" is only
 * valid for the plan identities it was answered about, and re-matching either
 * side to a different canonical makes it a stale answer to a question nobody
 * asked. Derived from the ids themselves — no expiry field to go stale.
 *
 * FLYWHEEL. A human resolving an identity the automated ladder could not is
 * precision-oracle signal for that ladder (the same class as a human confirming
 * a parse). Stored with `answeredAt` so a later calibration pass can measure
 * the resolver against real answers.
 *
 * Body: { planId, otherPlanId, answer: "different" }
 *
 * ONLY "different" is accepted today, deliberately. "same" is a coherent answer
 * and the loader could honour it as `carry` — but nothing sends it, and S311's
 * lesson was that a route half rots silently (`show_drift_banner_for_sent`
 * shipped server-side in PR #71 and no client consumer was EVER written). In
 * THIS surface "same" is also redundant: "Move to current plan" already says
 * "this care belongs here" by re-pinning. Widen the union when a caller needs
 * it — the needs-panel "My plan didn't change" affordance is the likely one.
 * Auth: Firebase bearer token; userScoped enforces ownership of BOTH rows.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export interface PlanIdentityAnswer {
  answer: "different";
  answeredAt: string;
  /** Both canonical ids AS ANSWERED — the reset gate. Null is a real value. */
  selfCanonicalId: string | null;
  otherCanonicalId: string | null;
}

export async function POST(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    planId?: unknown;
    otherPlanId?: unknown;
    answer?: unknown;
  } | null;
  if (!body || typeof body.planId !== "string" || !body.planId) {
    return NextResponse.json({ error: "planId required" }, { status: 400 });
  }
  if (typeof body.otherPlanId !== "string" || !body.otherPlanId) {
    return NextResponse.json({ error: "otherPlanId required" }, { status: 400 });
  }
  if (body.answer !== "different") {
    return NextResponse.json({ error: "answer must be 'different'" }, { status: 400 });
  }
  if (body.planId === body.otherPlanId) {
    return NextResponse.json({ error: "A plan cannot be answered against itself" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Ownership on BOTH rows. userScoped returns nothing for a foreign id, so a
  // caller cannot record an answer against someone else's plan (fails closed).
  const { data: rows } = await userScoped(supabase, user.id)
    .table("insurance_plans")
    .select("id, canonical_plan_id, metadata")
    .in("id", [body.planId, body.otherPlanId]);
  const self = (rows ?? []).find((r) => r.id === body.planId);
  const other = (rows ?? []).find((r) => r.id === body.otherPlanId);
  if (!self || !other) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

  const entry: PlanIdentityAnswer = {
    answer: "different",
    answeredAt: new Date().toISOString(),
    selfCanonicalId: (self.canonical_plan_id as string | null) ?? null,
    otherCanonicalId: (other.canonical_plan_id as string | null) ?? null,
  };

  // Spread-merge so sibling metadata (eoc_* bags, confirm stamps) survives.
  const meta = (self.metadata ?? {}) as Record<string, unknown>;
  const answers = (meta.planIdentityAnswers ?? {}) as Record<string, unknown>;
  const nextMeta = {
    ...meta,
    planIdentityAnswers: { ...answers, [body.otherPlanId]: entry },
  };

  const { error } = await userScoped(supabase, user.id)
    .table("insurance_plans")
    .update({ metadata: nextMeta })
    .eq("id", body.planId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, answer: entry.answer });
}
