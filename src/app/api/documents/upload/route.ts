import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { FLAGS } from "@/lib/config/feature-flags";
import { quickClassify } from "@/lib/classifier/quick-classify";
import { notifyAdminForReview, notifyUserPendingReview } from "@/lib/notifications";
import { enqueueChunk } from "@/lib/queue/qstash";
import { matchInsurerCatalog } from "@/lib/plan/insurer-match";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { verifyTurnstileToken, getRemoteIp } from "@/lib/security/turnstile";
import {
  computeFileHash,
  extractPlanIdentifiers,
  extractPlanIdentifiersWithHaiku,
  shouldSkipExtraction,
  linkDocumentToCanonical,
} from "@/lib/plan/extraction-dedup";

// CF-36 (Session 72) — test account exemption from per-user document caps.
// Hardcoded single-account escape hatch so MVP testing iterations aren't
// blocked by upload limits. Revisit at OPS Sprint pre-OPS.1 to convert to a
// proper admin role + flag (Phase 2 follow-up).
const TEST_EXEMPT_EMAIL = "andrew.david.ullmann@gmail.com";

function isTestExemptUser(decoded: { email?: string | null } | null): boolean {
  return decoded?.email?.toLowerCase() === TEST_EXEMPT_EMAIL;
}

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
  const turnstileToken = (formData.get("turnstileToken") as string) || undefined;
  // purpose (mig 078): "primary" (default; replaces user's active plan) vs
  // "comparison" (via /compare; persists for flywheel but does NOT touch the
  // user's active plan). Validate the input so an attacker can't smuggle
  // arbitrary values into a CHECK-constrained column.
  const rawPurpose = (formData.get("purpose") as string) || "primary";
  const purpose: "primary" | "comparison" = rawPurpose === "comparison" ? "comparison" : "primary";

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Turnstile gate (S68 mig 075). Authenticated route, but bot defense still
  // matters: a compromised account or spammy authenticated client can burn
  // OCR/Haiku budget without it.
  const turnstileEnforced = await isFeatureEnabled("turnstile_enforcement_v1");
  if (turnstileEnforced) {
    const verify = await verifyTurnstileToken(turnstileToken, getRemoteIp(req));
    if (!verify.success) {
      console.warn(
        "[upload] Turnstile verification failed for user=" + user.id +
          ", errors=" + JSON.stringify(verify.errorCodes ?? []),
      );
      return NextResponse.json(
        { error: "Bot defense check failed. Please reload and try again." },
        { status: 403 },
      );
    }
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

  // Recover stuck documents — reset any "processing" docs older than 5 min
  // OR "queued" docs older than 10 min (longer threshold for queued because
  // QStash delivery has built-in retries; we wait longer before declaring
  // stuck) to "error". Per S74.5c C-7 — closes the dedup-to-stuck-queued
  // gap where §1.6's whitelist would otherwise return an infinitely-pending
  // doc on re-upload.
  await supabase
    .from("documents")
    .update({ status: "error", processing_error: "Processing timed out. Please try uploading again." })
    .eq("user_id", user.id)
    .eq("status", "processing")
    .lt("created_at", new Date(Date.now() - 5 * 60 * 1000).toISOString());
  await supabase
    .from("documents")
    .update({ status: "error", processing_error: "Processing did not start in time. Please try uploading again." })
    .eq("user_id", user.id)
    .eq("status", "queued")
    .lt("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

  // CF-36: test account is exempt from both per-user and daily caps.
  const exemptFromCaps = isTestExemptUser(decoded);

  if (!exemptFromCaps) {
    // Check per-user document limit (exclude errored/failed docs and card scan audit trail)
    const { count: userDocCount } = await supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .neq("doc_type", "insurance_card")
      .in("status", ["uploaded", "queued", "processing", "processed"]);

    if (userDocCount != null && userDocCount >= FLAGS.UPLOAD_MAX_PER_USER) {
      return NextResponse.json(
        { error: `You've reached the upload limit of ${FLAGS.UPLOAD_MAX_PER_USER} documents. Contact support if you need more.` },
        { status: 429 }
      );
    }

    // Daily upload cap — 10 uploads per calendar day (excludes card scan audit trail)
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const { count: todayCount } = await supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .neq("doc_type", "insurance_card")
      .gte("created_at", dayStart.toISOString());

    const DAILY_UPLOAD_LIMIT = parseInt(process.env.DAILY_UPLOAD_LIMIT || "10", 10);
    if (todayCount != null && todayCount >= DAILY_UPLOAD_LIMIT) {
      return NextResponse.json(
        { error: `You've reached the daily upload limit of ${DAILY_UPLOAD_LIMIT} documents. Try again tomorrow.` },
        { status: 429 }
      );
    }
  } else {
    console.log("[upload] CF-36 test-account cap exemption applied for", decoded.email);
  }

  const documentId = crypto.randomUUID();
  const ext = file.name.split(".").pop()?.toLowerCase() || "pdf";
  const storagePath = `${user.id}/${documentId}.${ext}`;
  const contentType = file.type || (isHeic ? "image/heic" : "application/octet-stream");

  const buffer = Buffer.from(await file.arrayBuffer());

  // S74.5 D11 (Session 83) — ingestion-layer file-hash dedup. Compute SHA-256
  // of the file bytes; if (user_id, file_hash) already exists in documents,
  // short-circuit and return the existing documentId. This prevents the
  // duplicate-claims pipeline that motivated D11 from re-firing whenever a
  // user re-uploads the same PDF. Hash is computed in-memory (file already
  // loaded for storage upload anyway), so the check has zero extra IO.
  // Comparison-purpose uploads are EXCLUDED from dedup — by design those
  // intentionally upload alternate plan docs that may share filenames or
  // even bytes if the user copies one comparison to another slot; the
  // /compare flow needs distinct documents rows per slot.
  const fileHash = computeFileHash(buffer);
  if (purpose !== "comparison") {
    // S74.5c §1.6 — only dedup against docs that have actually entered the
    // processing pipeline. `uploaded` is the limbo state before quick-classify
    // wires the doc up; if a prior upload got stuck there (transient classify
    // failure, server crash mid-flight, etc.), deduping to it leaves the user
    // staring at an infinite spinner. The recovery block above (line ~124)
    // already auto-resets long-stuck `processing` docs to `error`, which
    // correctly excludes them from this whitelist via the .in() filter.
    const { data: existingDoc } = await supabase
      .from("documents")
      .select("id, doc_type, status, file_name, created_at")
      .eq("user_id", user.id)
      .eq("file_hash", fileHash)
      .in("status", ["queued", "processing", "processed"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingDoc) {
      console.log(
        `[upload] file-hash dedup hit — reusing existing documentId ${existingDoc.id} for user ${user.id}`,
      );
      return NextResponse.json({
        documentId: existingDoc.id as string,
        status: existingDoc.status as string,
        deduplicated: true,
        existingFileName: existingDoc.file_name as string,
      });
    }
  }

  // Upload to storage
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

  // Insert document record. NOTE: `purpose` is set in a follow-up UPDATE
  // (rather than included in this insert) so the upload route still works
  // before mig 078 is applied — if the documents.purpose column doesn't exist,
  // the UPDATE errors silently and the upload falls back to primary behavior
  // downstream. Once mig 078 is applied, the UPDATE persists purpose and the
  // processing pipeline branches correctly for comparison uploads.
  const { error: dbError } = await supabase.from("documents").insert({
    id: documentId,
    user_id: user.id,
    storage_path: storagePath,
    file_name: file.name,
    file_size: file.size,
    doc_type: docType,
    consent_event_id: consentEvent.id,
    status: "uploaded",
    // S74.5 D11 — write the hash so future re-uploads dedup at the check
    // above. Pre-mig 090 DBs will reject this insert; tolerated by wrapping
    // the file_hash column write in a follow-up UPDATE pattern (same as
    // mig 078 purpose handling). Simpler: insert with hash inline; if mig
    // is unapplied the entire insert fails (loud rather than silent). At
    // this point mig 090 is a hard prereq.
    file_hash: fileHash,
  });

  if (dbError) {
    console.error("Document insert error:", dbError);
    return NextResponse.json({ error: "Failed to save document record." }, { status: 500 });
  }

  // Mig 078 (additive) — set purpose only when it differs from the default
  // "primary". Wrapped to swallow errors silently so the upload still works
  // if the column doesn't exist yet (pre-mig DB falls back to primary
  // treatment downstream — i.e., comparison uploads will overwrite until
  // the migration is applied).
  if (purpose === "comparison") {
    const { error: purposeErr } = await supabase
      .from("documents")
      .update({ purpose: "comparison" })
      .eq("id", documentId);
    if (purposeErr) {
      console.warn(
        "[upload] Could not set documents.purpose=comparison — has mig 078 been applied?",
        purposeErr.message,
      );
    }
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
    // Fix 11: Don't leave doc in "uploaded" limbo — mark as error
    await supabase.from("documents").update({
      status: "error",
      processing_error: "Classification failed — please retry or contact support.",
    }).eq("id", documentId);
    try {
      await notifyAdminForReview(documentId, "unknown", 0, file.name, decoded.email || "");
    } catch { /* non-critical */ }
    return NextResponse.json({ documentId, storagePath, status: "error", error: "Classification failed" }, { status: 500 });
  }

  const userEmail = decoded.email || "";
  let fileHashComputed: string | null = null;

  // ── Smart extraction skip (feature-flagged) ─────────────────────────────
  // Check if this document matches a known canonical plan with stable data.
  // If so, skip full OCR + Haiku extraction and link directly to canonical.
  if (["sbc", "plan_document"].includes(classification.classifiedType)) {
    try {
      const { isFeatureEnabled } = await import("@/lib/config/product-flags");
      const dedupEnabled = await isFeatureEnabled("document_dedup", userEmail);

      if (dedupEnabled) {
        fileHashComputed = computeFileHash(buffer);

        // Two-tier identifier extraction: regex first, Haiku fallback
        let identifiers = extractPlanIdentifiers(classification.ocrTextPreview);
        if (!identifiers.insurer || !identifiers.planName) {
          identifiers = await extractPlanIdentifiersWithHaiku(classification.ocrTextPreview);
        }

        // Save hash to document record
        await supabase.from("documents").update({ file_hash: fileHashComputed }).eq("id", documentId);

        const dedupResult = await shouldSkipExtraction(supabase, documentId, fileHashComputed, identifiers, user.id, classification.classifiedType);
        console.log(`[upload] Dedup check: skip=${dedupResult.skip}, reason=${dedupResult.reason}, identifiers=${identifiers.source}`);

        if (dedupResult.skip && dedupResult.canonicalPlanId) {
          const result = await linkDocumentToCanonical(
            supabase,
            { id: documentId, user_id: user.id, file_name: file.name },
            dedupResult.canonicalPlanId,
            classification.ocrTextPreview,
            identifiers
          );

          if (result.success) {
            console.log(`[upload] Extraction skipped — linked to canonical ${dedupResult.canonicalPlanId}. Services: ${result.servicesCreated}`);
            return NextResponse.json({
              documentId,
              storagePath,
              autoProcessed: true,
              skippedExtraction: true,
              dedupReason: dedupResult.reason,
              classification: {
                classifiedType: classification.classifiedType,
                confidence: classification.confidence,
                pageCount: classification.pageCount,
              },
            });
          }
          // If linkDocumentToCanonical failed, fall through to normal processing
          console.warn(`[upload] Dedup link failed: ${result.error}. Falling through to normal pipeline.`);
        }
      }
    } catch (dedupErr) {
      // Non-fatal — fall through to normal processing
      console.error("[upload] Dedup check failed (non-fatal):", dedupErr);
    }
  }

  // ── File hash rate limit (same file 3+ times → reject) ──────────────────
  // Hash may already be computed by dedup block above — reuse if so
  if (!fileHashComputed) {
    fileHashComputed = computeFileHash(buffer);
    await supabase.from("documents").update({ file_hash: fileHashComputed }).eq("id", documentId);
  }

  // CF-36: test account also exempt from per-file-hash duplicate limit so
  // testing the same SBC repeatedly doesn't trip the rate limiter.
  if (!exemptFromCaps) {
    const { count: hashCount } = await supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("file_hash", fileHashComputed);

    if (hashCount != null && hashCount >= 3) {
      await supabase.from("documents").update({
        status: "error",
        processing_error: "This file has been uploaded too many times.",
      }).eq("id", documentId);
      return NextResponse.json(
        { error: "You've already uploaded this file 3 times. Use the retry button on your existing upload if you need to reprocess." },
        { status: 429 }
      );
    }
  }

  // HIGH confidence — queue for processing via QStash (guaranteed delivery)
  // ALL documents go through the same chunked pipeline — no fire-and-forget fetch.
  if (classification.confidence >= CONFIDENCE_HIGH) {
    try {
      await supabase.from("documents").update({
        status: "queued",
        processing_total_pages: classification.pageCount,
      }).eq("id", documentId);

      const baseUrl = req.headers.get("x-forwarded-proto") && req.headers.get("x-forwarded-host")
        ? `${req.headers.get("x-forwarded-proto")}://${req.headers.get("x-forwarded-host")}`
        : new URL(req.url).origin;
      const enqueued = await enqueueChunk(documentId, baseUrl);

      if (!enqueued) {
        await supabase.from("documents").update({
          status: "error",
          processing_error: "Failed to enqueue for processing — please retry.",
        }).eq("id", documentId);
        return NextResponse.json({ documentId, storagePath, status: "error", error: "Failed to enqueue" }, { status: 500 });
      }

      // S78 — async ingestion gate: large PDFs (>30 pages) get the async splash
      // + parse-complete email + banner UX. Sub-30 page docs keep the existing
      // sync PlayfulParsingScreen flow. Gated behind `async_ingestion_ux_v1`
      // feature flag (mig 085, default OFF in dev). Page-count gate is purely
      // PDF-based — HEIC / JPEG cards are 1 "page" and always sync.
      const asyncIngestionEnabled = await isFeatureEnabled("async_ingestion_ux_v1", userEmail);
      const isLargeDoc =
        asyncIngestionEnabled &&
        classification.pageCount > 30 &&
        contentType === "application/pdf";

      return NextResponse.json({
        documentId,
        storagePath,
        autoProcessed: true,
        isLargeDoc,
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

  // S90 asymmetric trust rule. Classifier confidence is a noisy signal —
  // measured 0.6 vs 0.99 on back-to-back identical-shape SBC uploads.
  // Threshold tiers route the trade-off between auto-process friction
  // (good for users) and downstream risk (bad if values are wrong).
  //
  // Plan-docs (sbc/eoc/plan_document):
  //   - HIGH ≥0.8         → full process (canonical + user)
  //   - MEDIUM 0.4-0.8    → auto-process user-scoped only (dispatcher's
  //                          resolveDocumentType returns skipCanonical=true
  //                          → shared canonical_plans untouched per Pattern
  //                          1 #14). Frontend renders supplement prompt.
  //   - LOW <0.4          → pending_review
  //
  // Bills (eob/itemized_bill):
  //   - HIGH ≥0.8         → full process (audit fires; dispute enabled)
  //   - UPPER-MED 0.6-0.8 → auto-process + verification supplement prompt
  //                          gating dispute generation (CROA-risk mitigation
  //                          via user-in-the-loop, not blocking).
  //   - LOWER-MED 0.4-0.6 → pending_review (parser misread on shaky data
  //                          could produce wrong recovery amounts → wrong
  //                          dispute letter → CROA exposure).
  //   - LOW <0.4          → pending_review
  const userSelectedHealthcareType = ["eob", "itemized_bill", "sbc", "plan_document"].includes(docType);
  const effectiveType = userSelectedHealthcareType ? docType : classification.classifiedType;
  const PLAN_DOC_TYPES = new Set(["sbc", "eoc", "plan_document"]);
  const BILL_TYPES_SET = new Set(["eob", "itemized_bill"]);
  const CONFIDENCE_BILL_AUTO_FLOOR = 0.6;
  const isPlanDocPath = PLAN_DOC_TYPES.has(effectiveType);
  const isBillPath = BILL_TYPES_SET.has(effectiveType);

  const autoProcessAtMedium =
    (classification.confidence >= CONFIDENCE_LOW && isPlanDocPath) ||
    (classification.confidence >= CONFIDENCE_BILL_AUTO_FLOOR && isBillPath);

  if (autoProcessAtMedium) {
    try {
      await supabase.from("documents").update({
        status: "queued",
        processing_total_pages: classification.pageCount,
      }).eq("id", documentId);

      const baseUrl = req.headers.get("x-forwarded-proto") && req.headers.get("x-forwarded-host")
        ? `${req.headers.get("x-forwarded-proto")}://${req.headers.get("x-forwarded-host")}`
        : new URL(req.url).origin;
      const enqueued = await enqueueChunk(documentId, baseUrl);

      if (!enqueued) {
        await supabase.from("documents").update({
          status: "error",
          processing_error: "Failed to enqueue for processing — please retry.",
        }).eq("id", documentId);
        return NextResponse.json({ documentId, storagePath, status: "error", error: "Failed to enqueue" }, { status: 500 });
      }

      return NextResponse.json({
        documentId,
        storagePath,
        autoProcessed: true,
        mediumConfidence: true,
        classification: {
          classifiedType: classification.classifiedType,
          confidence: classification.confidence,
          pageCount: classification.pageCount,
        },
      });
    } catch (err) {
      console.error("[upload] Auto-process (medium) error:", err);
      // Fall through to pending_review
    }
  }

  // MEDIUM confidence bill/EOB OR any other healthcare signal — queue for
  // admin review. Auto-reject only when classifier finds zero signals AND the
  // user didn't select a specific type.
  if (classification.confidence >= CONFIDENCE_LOW || classification.classifiedType !== "other" || userSelectedHealthcareType) {
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

      const insurerRaw = profile?.insurer || "Unknown";
      const insurerMatch = await matchInsurerCatalog(supabase, insurerRaw);

      const { error: queueErr } = await supabase.from("insurer_discovery_queue").insert({
        insurer_name_raw: insurerRaw,
        requested_by: user.id,
        source: "user_submitted",
        source_document_id: documentId,
        status: "pending",
        matched_insurer_id: insurerMatch?.id || null,
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
