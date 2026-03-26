import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  try {
    // Authenticate via Firebase token
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const idToken = authHeader.slice(7);
    let decoded;
    try {
      decoded = await getAdminAuth().verifyIdToken(idToken);
    } catch {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const supabase = createServerClient();

    // Look up the Candid user by Firebase UID
    const { data: user } = await supabase
      .from("users")
      .select("id, email")
      .eq("firebase_uid", decoded.uid)
      .single();

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Create a support ticket for the CCPA data export request
    const { error: insertError } = await supabase
      .from("support_tickets")
      .insert({
        user_id: user.id,
        email: user.email,
        category: "data_export_request",
        subject: "CCPA Data Export Request",
        message:
          "Automated request for data export in JSON format per CCPA/CPRA Right to Access.",
        status: "open",
      });

    if (insertError) {
      console.error("[account/export] Insert error:", insertError);
      return NextResponse.json(
        { error: `Failed to create export request: ${insertError.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message:
        "Export request received. We will email your data within 30 days.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[account/export] Unhandled error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
