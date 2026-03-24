import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ isAdmin: false }, { status: 401 });
  }

  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();

    const { data: user } = await supabase
      .from("users")
      .select("is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();

    return NextResponse.json({ isAdmin: user?.is_admin ?? false });
  } catch {
    return NextResponse.json({ isAdmin: false }, { status: 401 });
  }
}
