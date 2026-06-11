import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";

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
      .select("id, firebase_uid, email")
      .eq("firebase_uid", decoded.uid)
      .single();

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const userId = user.id;
    const deletionLog: string[] = [];

    // 1. Delete document files from Supabase Storage
    const { data: docs } = await userScoped(supabase, userId)
      .table("documents")
      .select("id, storage_path");

    if (docs && docs.length > 0) {
      const paths = docs.map((d) => d.storage_path);
      await supabase.storage.from("documents").remove(paths);
      deletionLog.push(`${docs.length} document file(s) removed from storage`);
    }

    // 2. Delete document records
    await userScoped(supabase, userId).table("documents").delete();
    deletionLog.push("Document records deleted");

    // 3. Delete support tickets
    await userScoped(supabase, userId).table("support_tickets").delete();
    deletionLog.push("Support tickets deleted");

    // 4. Delete consent events (bypasses immutable RLS via service role)
    await userScoped(supabase, userId).table("consent_events").delete();
    deletionLog.push("Consent events deleted");

    // 5. Delete stripe_customers
    await userScoped(supabase, userId).table("stripe_customers").delete();
    deletionLog.push("Stripe record deleted");

    // 6. Delete profile
    await userScoped(supabase, userId).table("profiles").delete();
    deletionLog.push("Profile deleted");

    // 7. Delete user record (cascade handles anything remaining)
    await supabase.from("users").delete().eq("id", userId);
    deletionLog.push("User record deleted");

    // 8. Delete from Firebase Auth
    try {
      await getAdminAuth().deleteUser(user.firebase_uid);
      deletionLog.push("Firebase Auth account deleted");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (fbErr: any) {
      // User may already be deleted from Firebase
      if (fbErr?.code !== "auth/user-not-found") {
        deletionLog.push(`Firebase deletion failed: ${fbErr.message}`);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Account deletion error:", error);
    return NextResponse.json(
      { error: "Failed to delete account" },
      { status: 500 }
    );
  }
}
