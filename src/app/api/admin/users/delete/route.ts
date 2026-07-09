import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { logAdminAction } from "@/lib/admin/audit-log";
import { requireAdmin } from "@/lib/admin/require-admin";

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;
    const { supabase, adminUserId, adminEmail } = auth;

    const { userId } = await req.json();
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    // Prevent self-deletion
    if (userId === adminUserId) {
      return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
    }

    // Get user to verify they exist and get Firebase UID
    const { data: targetUser } = await supabase
      .from("users")
      .select("id, firebase_uid, email")
      .eq("id", userId)
      .single();

    if (!targetUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const deletionLog: string[] = [];

    // 1. Delete document files from Supabase Storage
    const { data: docs } = await supabase
      .from("documents")
      .select("id, storage_path")
      .eq("user_id", userId);

    if (docs && docs.length > 0) {
      const paths = docs.map((d) => d.storage_path);
      await supabase.storage.from("documents").remove(paths);
      deletionLog.push(`${docs.length} document file(s) removed from storage`);
    }

    // 2. Delete document records
    await supabase.from("documents").delete().eq("user_id", userId);
    deletionLog.push("Document records deleted");

    // 3. Delete support tickets
    await supabase.from("support_tickets").delete().eq("user_id", userId);
    deletionLog.push("Support tickets deleted");

    // 4. Delete consent events (bypasses immutable RLS via service role)
    await supabase.from("consent_events").delete().eq("user_id", userId);
    deletionLog.push("Consent events deleted");

    // 5. Delete stripe_customers
    await supabase.from("stripe_customers").delete().eq("user_id", userId);
    deletionLog.push("Stripe record deleted");

    // 6. Delete profile
    await supabase.from("profiles").delete().eq("user_id", userId);
    deletionLog.push("Profile deleted");

    // 6b. Hard-delete the two ON DELETE SET NULL tables (#191 parity with the
    // self-serve account-delete route). These are NOT cleaned by the users-row
    // CASCADE below — their FK is SET NULL — so without this they would be
    // ORPHANED, including the insurer_appeals_confirmations.metadata PII blob,
    // defeating the right-to-erasure promise for admin-initiated deletions.
    await supabase.from("finding_dismissals").delete().eq("user_id", userId);
    deletionLog.push("Finding dismissals deleted");

    await supabase.from("insurer_appeals_confirmations").delete().eq("user_id", userId);
    deletionLog.push("Insurer appeal confirmations deleted");

    // 7. Delete user record (cascade handles anything remaining)
    await supabase.from("users").delete().eq("id", userId);
    deletionLog.push("User record deleted");

    // 8. Delete from Firebase Auth
    try {
      await getAdminAuth().deleteUser(targetUser.firebase_uid);
      deletionLog.push("Firebase Auth account deleted");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (fbErr: any) {
      // User may already be deleted from Firebase
      if (fbErr?.code !== "auth/user-not-found") {
        deletionLog.push(`Firebase deletion failed: ${fbErr.message}`);
      }
    }

    // Audit log
    await logAdminAction({
      adminUserId,
      adminEmail,
      action: "user_delete",
      targetUserId: targetUser.id,
      details: `Deleted user ${targetUser.email}`,
      ipAddress: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip"),
    });

    return NextResponse.json({
      success: true,
      email: targetUser.email,
      log: deletionLog,
    });
  } catch (error) {
    console.error("User deletion error:", error);
    return NextResponse.json(
      { error: "Failed to delete user" },
      { status: 500 }
    );
  }
}
