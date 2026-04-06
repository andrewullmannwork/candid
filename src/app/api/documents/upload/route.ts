import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { FLAGS } from "@/lib/config/feature-flags";
import { quickClassify } from "@/lib/classifier/quick-classify";
import { notifyAdminForReview, notifyUserPendingReview } from "@/lib/notifications";

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
  if (file.size > FLAGS.UPLOAD_MAX_FILE_SIZE) {
    return NextResponse.json({ error: `File must be under ${Math.round(FLAGS.UPLOAD_MAX_FILE_SIZE / 1024 / 1024)}MB.` }, { status: 400 });
  }

  // Check per-user document limit
  const { count: userDocCount } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

  if (userDocCount != null && userDocCount >= FLAGS.UPLOAD_MAX_PER_USER) {
    return NextResponse.json(
      { error: `You've reached the upload limit of ${FLAGS.UPLOAD_MAX_PER_USER} documents. Contact support if you need more.` },
      { status: 429 }
    );
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
    const msg = uploadError.message?.includes("not found")
      ? "Storage bucket not configured. Please contact support."
      : "Failed to upload file. Please try again.";
    return NextResponse.json({ error: msg }, { status: 500 });
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

  // ── Confidence-gated processing ─────────────────────────────────────────
  // Quick-classify using first 2 pages only (saves OCR budget on rejected docs)
  const CONFIDENCE_HIGH = parseFloat(process.env.CONFIDENCE_THRESHOLD_HIGH || "0.8");
  const CONFIDENCE_LOW = parseFloat(process.env.CONFIDENCE_THRESHOLD_LOW || "0.4");

  let classification = null;
  try {
    classification = await quickClassify(buffer, contentType);

    // Store classification results
    await supabase.from("documents").update({
      classified_type: classification.classifiedType,
      classification_confidence: classification.confidence,
      type_mismatch: classification.classifiedType !== docType,
    }).eq("id", documentId);

    console.log(`[upload] Quick classify: ${classification.classifiedType} (${Math.round(classification.confidence * 100)}%) | ${classification.pageCount} pages | file: ${file.name}`);
  } catch (classifyErr) {
    console.error("[upload] Quick classification failed:", classifyErr);
    // Fall through to return uploaded state — don't block the upload
    return NextResponse.json({ documentId, storagePath, status: "uploaded" });
  }

  const userEmail = decoded.email || "";

  // HIGH confidence — auto-process immediately
  if (classification.confidence >= CONFIDENCE_HIGH) {
    // Trigger full processing in the background (non-blocking)
    // The frontend will poll or the user navigates to see results
    try {
      await supabase.from("documents").update({ status: "processing" }).eq("id", documentId);

      // Call the process endpoint internally
      const processUrl = new URL("/api/documents/process", req.url);
      fetch(processUrl.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: req.headers.get("authorization") || "",
        },
        body: JSON.stringify({ documentId, billType: docType }),
      }).catch((err) => {
        console.error("[upload] Auto-process trigger failed:", err);
      });

      return NextResponse.json({
        documentId,
        storagePath,
        autoProcessed: true,
        classification: {
          classifiedType: classification.classifiedType,
          confidence: classification.confidence,
          pageCount: classification.pageCount,
        },
      });
    } catch (err) {
      console.error("[upload] Auto-process error:", err);
      // Fall through — at least the document is stored
    }
  }

  // MEDIUM confidence OR any recognized healthcare type — queue for admin review
  // Only auto-reject documents classified as "other" (no healthcare signals at all)
  if (classification.confidence >= CONFIDENCE_LOW || classification.classifiedType !== "other") {
    await supabase.from("documents").update({ status: "pending_review" }).eq("id", documentId);

    // Notify admin (email + Slack) and user (email) — non-blocking
    Promise.allSettled([
      notifyAdminForReview(documentId, classification.classifiedType, classification.confidence, file.name, userEmail),
      notifyUserPendingReview(userEmail, file.name),
    ]).catch(() => {});

    // Also queue for pipeline discovery if it looks like an SBC
    if (classification.classifiedType === "sbc" || classification.classifiedType === "plan_document") {
      const { data: profile } = await supabase
        .from("profiles")
        .select("insurer")
        .eq("user_id", user.id)
        .single();

      const { error: queueErr } = await supabase.from("insurer_discovery_queue").insert({
        insurer_name_raw: profile?.insurer || "Unknown",
        requested_by: user.id,
        source: "user_submitted",
        source_document_id: documentId,
        status: "pending",
      });
      if (queueErr) console.warn("[upload] Discovery queue insert failed:", queueErr.message);
    }

    return NextResponse.json({
      documentId,
      storagePath,
      status: "pending_review",
      classification: {
        classifiedType: classification.classifiedType,
        confidence: classification.confidence,
        pageCount: classification.pageCount,
      },
    });
  }

  // No healthcare signals at all — auto-decline
  await supabase.from("documents").update({ status: "rejected" }).eq("id", documentId);
  console.log(`[upload] Auto-rejected: ${file.name} (${Math.round(classification.confidence * 100)}% as ${classification.classifiedType})`);

  return NextResponse.json({
    documentId,
    storagePath,
    status: "rejected",
    classification: {
      classifiedType: classification.classifiedType,
      confidence: classification.confidence,
    },
    message: "This doesn't appear to be a healthcare document. Please upload an insurance card, Summary of Benefits (SBC), Explanation of Benefits (EOB), or medical bill.",
  });
}
