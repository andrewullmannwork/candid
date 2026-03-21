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

  // Look up internal user ID from Firebase UID
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

  return NextResponse.json({
    profile: profile || {
      insurer: null,
      plan_type: null,
      state: null,
      primary_concern: null,
    },
  });
}

/** POST /api/profile — save/update the current user's profile */
export async function POST(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { insurer, plan_type, state, primary_concern } = body;

  const supabase = createServerClient();

  // Look up internal user ID from Firebase UID
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { error } = await supabase.from("profiles").upsert(
    {
      user_id: user.id,
      insurer: insurer || null,
      plan_type: plan_type || null,
      state: state || null,
      primary_concern: primary_concern || null,
    },
    { onConflict: "user_id" }
  );

  if (error) {
    console.error("Profile save error:", error);
    return NextResponse.json({ error: "Failed to save profile" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
