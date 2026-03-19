import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  try {
    // Verify auth
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const idToken = authHeader.slice(7);
    const decoded = await getAdminAuth().verifyIdToken(idToken);
    const supabase = createServerClient();

    // Find user
    const { data: user } = await supabase
      .from("users")
      .select("id")
      .eq("firebase_uid", decoded.uid)
      .single();

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const { consentType } = await req.json();

    // If revoking health_data_upload, delete all uploaded documents
    if (consentType === "health_data_upload") {
      // Get all document storage paths
      const { data: docs } = await supabase
        .from("documents")
        .select("id, storage_path")
        .eq("user_id", user.id);

      if (docs && docs.length > 0) {
        // Delete from storage
        const paths = docs.map((d) => d.storage_path);
        await supabase.storage.from("documents").remove(paths);

        // Delete document records
        for (const doc of docs) {
          await supabase.from("documents").delete().eq("id", doc.id);
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Consent revocation error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
