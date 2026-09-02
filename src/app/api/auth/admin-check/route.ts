import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ isAdmin: false, isOperator: false }, { status: 401 });
  }

  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();

    const { data: user } = await supabase
      .from("users")
      .select("is_admin, is_operator")
      .eq("firebase_uid", decoded.uid)
      .single();

    // S330 — the operator role admits a user to the /admin/dfy section ONLY
    // (the admin layout gates the rest). Admins have the same permissions there.
    return NextResponse.json({
      isAdmin: user?.is_admin ?? false,
      isOperator: (user as { is_operator?: boolean } | null)?.is_operator ?? false,
    });
  } catch {
    return NextResponse.json({ isAdmin: false, isOperator: false }, { status: 401 });
  }
}
