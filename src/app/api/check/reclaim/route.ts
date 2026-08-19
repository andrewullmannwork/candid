import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/security/require-authenticated-user";
import { getAdminAuth } from "@/lib/firebase/admin";
import { finalizePlanActivation } from "@/lib/claims/claim-plan-link";
import { userScoped } from "@/lib/security/user-scoped";

/**
 * /api/check/reclaim — the S315 A-6 email bridge (Andrew's design).
 *
 * An anonymous /check run stores its typed contact in users.contact_email
 * (never identity — users.email stays synthetic so a typed address can't
 * collide with a real account). When the SAME address later owns a real,
 * VERIFIED account, that account may reclaim the abandoned check.
 *
 * Security shape (the whole point):
 *  - Match is on contact_email = the VERIFIED account email. Verification is
 *    the ownership proof: signup alone proves nothing (anyone can sign up
 *    with any address), so the reclaim is refused until email_verified —
 *    the existing verification machinery does the security work. Without
 *    this gate an attacker signing up with a victim's address would inherit
 *    the victim's health documents.
 *  - OFFER, never silent (mirrors StrandedPlanBanner's prompt-not-auto rule):
 *    GET lists what's reclaimable; POST executes only on the user's click.
 *    Declining is just never-POSTing — abandoned rows age out with the
 *    anonymous-retention window.
 *
 * GET  → { checks: [{ anonUserId, checkedAt, documents, claims }] }
 * POST { anonUserId } → moves the anonymous tree onto the caller's account
 *   (user_id repoint on documents / claims / insurance_plans / consent_events /
 *   claim_case_events / document_extraction_log — claim_line_items and
 *   plan_covered_services follow their parents), activates the reclaimed plan
 *   when the caller has none (which fires the standard activation adoption for
 *   the claims), then retires the anonymous users row.
 */

async function verifiedRequester(req: NextRequest) {
  const authed = await requireAuthenticatedUser(req);
  if (!authed || authed.isAnonymous) return null;
  // email_verified comes from the TOKEN (Firebase truth), not the mirror row.
  const header = req.headers.get("authorization") ?? "";
  try {
    const decoded = await getAdminAuth().verifyIdToken(header.slice(7));
    if (decoded.email_verified !== true) return null;
    return { ...authed, email: decoded.email ?? authed.email };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const user = await verifiedRequester(req);
  if (!user) return NextResponse.json({ checks: [] });
  const supabase = createServerClient();
  const { data: anons } = await supabase
    .from("users")
    .select("id, created_at")
    .eq("is_anonymous", true)
    .eq("contact_email", user.email);
  if (!anons || anons.length === 0) return NextResponse.json({ checks: [] });
  const checks = [];
  for (const a of anons) {
    const [docs, claims] = await Promise.all([
      userScoped(supabase, a.id).table("documents").select("id", { count: "exact", head: true }),
      userScoped(supabase, a.id).table("claims").select("id", { count: "exact", head: true }),
    ]);
    checks.push({
      anonUserId: a.id,
      checkedAt: a.created_at,
      documents: docs.count ?? 0,
      claims: claims.count ?? 0,
    });
  }
  return NextResponse.json({ checks });
}

const MOVE_TABLES = [
  "documents",
  "claims",
  "insurance_plans",
  "consent_events",
  "claim_case_events",
  "document_extraction_log",
] as const;

export async function POST(req: NextRequest) {
  const user = await verifiedRequester(req);
  if (!user) {
    return NextResponse.json({ error: "A verified account is required." }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { anonUserId?: string };
  if (!body.anonUserId) {
    return NextResponse.json({ error: "anonUserId required" }, { status: 400 });
  }
  const supabase = createServerClient();
  // The target must be an anonymous row whose typed contact IS the caller's
  // verified address — both conditions on the row itself, never client claims.
  const { data: anon } = await supabase
    .from("users")
    .select("id")
    .eq("id", body.anonUserId)
    .eq("is_anonymous", true)
    .eq("contact_email", user.email)
    .maybeSingle();
  if (!anon) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // The reclaimed plan (if any) BEFORE the move, so activation can follow.
  const { data: reclaimedActive } = await userScoped(supabase, anon.id)
    .table("insurance_plans")
    .select("id")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  for (const table of MOVE_TABLES) {
    const { error } = await userScoped(supabase, anon.id).table(table).update({ user_id: user.id });
    if (error) {
      console.error(`[check/reclaim] move failed on ${table} for anon ${anon.id}:`, error.message);
      return NextResponse.json(
        { error: "Restore hit a snag part-way — nothing was lost; try again." },
        { status: 500 },
      );
    }
  }

  // Activate the reclaimed plan only when the caller has none (prompt-not-auto
  // for anything that would CHANGE their active plan) — this repoint is the
  // standard activation seam, so the reclaimed claims adopt it right here.
  const { data: prof } = await userScoped(supabase, user.id)
    .table("profiles")
    .select("user_id, active_insurance_plan_id")
    .maybeSingle();
  if (reclaimedActive && prof && !prof.active_insurance_plan_id) {
    await userScoped(supabase, user.id)
      .table("profiles")
      .update({ active_insurance_plan_id: reclaimedActive.id });
    await finalizePlanActivation(supabase, user.id, reclaimedActive.id);
  } else if (reclaimedActive) {
    // Caller already has an active plan: the reclaimed one stays owned but
    // inactive — the standard flows (change-plan, corrections) take it from
    // here; auto-adopting claims onto either plan would be a guess.
    await userScoped(supabase, user.id)
      .table("insurance_plans")
      .update({ is_active: false })
      .eq("id", reclaimedActive.id);
  }

  // Retire the anonymous shell (profile row first, then the users row).
  await userScoped(supabase, anon.id).table("profiles").delete();
  const { error: userDelErr } = await supabase.from("users").delete().eq("id", anon.id);
  if (userDelErr) {
    // The data moved — the empty shell failing to delete is log-worthy, not fatal.
    console.warn(`[check/reclaim] anon shell delete failed for ${anon.id}:`, userDelErr.message);
  }
  return NextResponse.json({ ok: true });
}
