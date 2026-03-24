import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

/** Extract and verify the Firebase ID token from the Authorization header */
async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  const idToken = authHeader.slice(7);
  try {
    const decoded = await getAdminAuth().verifyIdToken(idToken);
    return decoded;
  } catch {
    return null;
  }
}

/** GET /api/profile — load the current user's profile */
export async function GET(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .single();

  return NextResponse.json({ profile: profile || null });
}

/** POST /api/profile — save/update the current user's profile (partial updates supported) */
export async function POST(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const {
    insurer,
    plan_type,
    plan_name,
    state,
    group_number,
    member_id,
    deductible_individual,
    oop_max_individual,
    copay_primary,
    copay_specialist,
    copay_er,
    coinsurance_pct,
    primary_concern,
    insurance_card_path,
    date_of_birth,
    sex,
    dependents,
  } = body;

  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Build update object — only include defined keys so partial saves don't overwrite existing data
  const update: Record<string, unknown> = { user_id: user.id };
  if (insurer !== undefined) update.insurer = insurer || null;
  if (plan_type !== undefined) update.plan_type = plan_type || null;
  if (plan_name !== undefined) update.plan_name = plan_name || null;
  if (state !== undefined) update.state = state || null;
  if (group_number !== undefined) update.group_number = group_number || null;
  if (member_id !== undefined) update.member_id = member_id || null;
  if (deductible_individual !== undefined) update.deductible_individual = deductible_individual || null;
  if (oop_max_individual !== undefined) update.oop_max_individual = oop_max_individual || null;
  if (copay_primary !== undefined) update.copay_primary = copay_primary || null;
  if (copay_specialist !== undefined) update.copay_specialist = copay_specialist || null;
  if (copay_er !== undefined) update.copay_er = copay_er || null;
  if (coinsurance_pct !== undefined) update.coinsurance_pct = coinsurance_pct || null;
  if (primary_concern !== undefined) update.primary_concern = primary_concern || null;
  if (insurance_card_path !== undefined) update.insurance_card_path = insurance_card_path || null;
  if (date_of_birth !== undefined) update.date_of_birth = date_of_birth || null;
  if (sex !== undefined) update.sex = sex || null;
  if (dependents !== undefined) {
    // Store as JSONB — parse if string, pass through if already object
    try {
      update.dependents = typeof dependents === "string" ? JSON.parse(dependents) : dependents;
    } catch {
      update.dependents = null;
    }
  }

  const { error } = await supabase
    .from("profiles")
    .upsert(update, { onConflict: "user_id" });

  if (error) {
    console.error("Profile save error:", error);
    return NextResponse.json({ error: "Failed to save profile" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
