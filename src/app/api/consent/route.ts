import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  try {
    const { action, consentType, consentVersion, consentTextHash } =
      (await req.json()) as {
        action: "grant" | "revoke" | "check";
        consentType: string;
        consentVersion: string;
        consentTextHash: string;
      };

    // Authenticate via Firebase token from Authorization header
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

    if (action === "check") {
      // Check current consent status
      const { data } = await supabase
        .from("consent_events")
        .select("consent_version, granted")
        .eq("user_id", user.id)
        .eq("consent_type", consentType)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      return NextResponse.json({
        hasConsented: data?.granted === true && data?.consent_version === consentVersion,
        needsReconsent: data?.granted === true && data?.consent_version !== consentVersion,
        currentVersion: data?.consent_version || null,
      });
    }

    // Grant or revoke
    const ip = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || null;
    const userAgent = req.headers.get("user-agent") || null;

    const { error: insertError } = await supabase.from("consent_events").insert({
      user_id: user.id,
      email: user.email,
      consent_type: consentType,
      consent_version: consentVersion,
      consent_text_hash: consentTextHash,
      granted: action === "grant",
      ip_address: ip,
      user_agent: userAgent,
    });

    if (insertError) {
      console.error("[consent] Insert error:", insertError);
      return NextResponse.json(
        { error: `Failed to record consent: ${insertError.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[consent] Unhandled error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
