import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  try {
    // Verify admin auth
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();

    // Verify caller is admin
    const { data: caller } = await supabase
      .from("users")
      .select("id, is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();

    if (!caller?.is_admin) {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 }
      );
    }

    // Create the admin_audit_log table
    const { error } = await supabase.rpc("exec_sql", {
      query: `
        CREATE TABLE IF NOT EXISTS admin_audit_log (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          admin_user_id UUID NOT NULL,
          admin_email TEXT NOT NULL,
          action TEXT NOT NULL,
          target_user_id UUID,
          target_table TEXT,
          details TEXT,
          ip_address TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON admin_audit_log(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action ON admin_audit_log(action);
      `,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: "admin_audit_log table created successfully",
    });
  } catch (error) {
    console.error("Setup audit log error:", error);
    return NextResponse.json(
      { error: "Failed to set up audit log" },
      { status: 500 }
    );
  }
}
