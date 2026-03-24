import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  // Get internal user ID
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Check consent
  const { data: consentEvent } = await supabase
    .from("consent_events")
    .select("id")
    .eq("user_id", user.id)
    .eq("consent_type", "health_data_upload")
    .eq("granted", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!consentEvent) {
    return NextResponse.json(
      { error: "Health data consent is required." },
      { status: 403 }
    );
  }

  // Parse form data
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const docType = (formData.get("docType") as string) || "eob";

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Validate file
  const allowedTypes = ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif"];
  const isHeic = /\.(heic|heif)$/i.test(file.name);
  if (!allowedTypes.includes(file.type) && !isHeic) {
    return NextResponse.json(
      { error: "Accepted formats: PDF, JPEG, PNG, or HEIC." },
      { status: 400 }
    );
  }
  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "File must be under 20MB." }, { status: 400 });
  }

  const documentId = crypto.randomUUID();
  const ext = file.name.split(".").pop()?.toLowerCase() || "pdf";
  const storagePath = `${user.id}/${documentId}.${ext}`;
  const contentType = file.type || (isHeic ? "image/heic" : "application/octet-stream");

  // Upload to storage
  const buffer = Buffer.from(await file.arrayBuffer());
  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(storagePath, buffer, { contentType });

  if (uploadError) {
    console.error("Storage upload error:", uploadError);
    return NextResponse.json({ error: "Failed to upload file." }, { status: 500 });
  }

  // Insert document record
  const { error: dbError } = await supabase.from("documents").insert({
    id: documentId,
    user_id: user.id,
    storage_path: storagePath,
    file_name: file.name,
    file_size: file.size,
    doc_type: docType,
    consent_event_id: consentEvent.id,
    status: "uploaded",
  });

  if (dbError) {
    console.error("Document insert error:", dbError);
    return NextResponse.json({ error: "Failed to save document record." }, { status: 500 });
  }

  // If SBC upload, auto-queue for pipeline extraction
  if (docType === "sbc") {
    // Get user's insurer name for the discovery queue
    const { data: profile } = await supabase
      .from("profiles")
      .select("insurer")
      .eq("user_id", user.id)
      .single();

    const insurerName = profile?.insurer || "Unknown";

    await supabase.from("insurer_discovery_queue").insert({
      insurer_name_raw: insurerName,
      requested_by: user.id,
      source: "user_submitted",
      source_document_id: documentId,
      status: "pending",
    });
  }

  return NextResponse.json({ documentId, storagePath });
}
