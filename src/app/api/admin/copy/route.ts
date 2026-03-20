import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { getAdminAuth } from "@/lib/firebase/admin";

async function verifyAdmin(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  const supabase = createServerClient();

  try {
    const decoded = await getAdminAuth().verifyIdToken(token);
    const { data: user } = await supabase
      .from("users")
      .select("id, is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();

    return user?.is_admin ? user : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("site_copy")
    .select("*")
    .order("section")
    .order("key");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ copy: data });
}

export async function PUT(req: NextRequest) {
  const admin = await verifyAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { key, value } = await req.json();
  if (!key || typeof value !== "string") {
    return NextResponse.json({ error: "Missing key or value" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { error } = await supabase
    .from("site_copy")
    .update({ value, updated_by: admin.id })
    .eq("key", key);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
