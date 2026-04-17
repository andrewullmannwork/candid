/**
 * POST /api/documents/process-chunk
 *
 * Chunked document processing for large PDFs that exceed Vercel's 10s timeout.
 * Each invocation does ONE unit of work (~5-8s), saves progress to DB, and returns.
 * The next step is triggered by dashboard polling or the daily safety-net cron.
 *
 * State machine:
 *   queued/null      → download, count pages, OCR chunk 0    → ocr_chunk_1
 *   ocr_chunk_N      → OCR chunk N, append text               → ocr_chunk_{N+1} or classifying
 *   classifying       → Haiku classify + extract + save (all inline, maxDuration=60) → processed
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { extractTextFromDocument } from "@/lib/ocr";
import { splitPDF, estimatePageCount } from "@/lib/ocr/document-ai";
import { processPlanDocumentData } from "@/lib/plan/process-plan";
import { parseBillFromOCR } from "@/lib/billing/parser";
import { parseBillWithHaiku } from "@/lib/billing/haiku-bill-parser";
import { runAudit } from "@/lib/audit";
import { collectPricingData } from "@/lib/care/collector";
import { checkProcessingBudget, recordProcessingUsage } from "@/lib/config/processing-usage";
import { enqueueChunk } from "@/lib/queue/qstash";
import { notifyAdminForReview } from "@/lib/notifications";

const CHUNK_SIZE = 15; // pages per OCR chunk

const BILL_TYPES = new Set(["eob", "itemized_bill"]);

/**
 * Process a bill/EOB document: parse → audit → persist claims → collect pricing.
 * Mirrors the logic in /api/documents/process but runs inline in the chunk pipeline.
 */
async function processBillDocument(
  supabase: SupabaseClient,
  doc: { id: string; user_id: string; file_name: string; doc_type: string },
  ocrText: string,
  documentId: string,
  billType: string,
): Promise<{ success: boolean; claimId?: string; findings?: number; error?: string }> {
  // Use Haiku for structured extraction (handles any format), fall back to regex
  const haikuParsed = await parseBillWithHaiku(ocrText, documentId, doc.user_id, billType as "eob" | "itemized_bill");
  const parsedBill = haikuParsed || parseBillFromOCR(
    { text: ocrText, pages: [], confidence: 0.8 },
    documentId,
    doc.user_id,
    billType as "eob" | "itemized_bill",
  );

  const auditReport = await runAudit(parsedBill);

  // Fetch user context once (used by claims, backflow, and code intelligence)
  const { isFeatureEnabled } = await import("@/lib/config/product-flags");
  const { data: userForFlag } = await supabase.from("users").select("email").eq("firebase_uid", doc.user_id).single();
  const userEmail = userForFlag?.email || undefined;

  const { data: profile } = await supabase
    .from("profiles")
    .select("active_insurance_plan_id, state")
    .eq("user_id", doc.user_id)
    .single();

  const insurancePlanId = profile?.active_insurance_plan_id || null;

  // Persist claims (feature-flagged)
  let claimId: string | null = null;
  try {
    const claimsEnabled = await isFeatureEnabled("claims_persistence", userEmail);
    if (claimsEnabled) {
      const { persistAuditResults } = await import("@/lib/claims/persist");
      const persistResult = await persistAuditResults(supabase, {
        userId: doc.user_id,
        insurancePlanId: insurancePlanId || undefined,
        documentId,
        parsedBill,
        auditReport,
      });
      claimId = persistResult?.claimId || null;
    }
  } catch (err) {
    console.error("[process-chunk] Claims persist failed (non-fatal):", err);
  }

  // Collect pricing data (non-blocking)
  try {
    await collectPricingData(parsedBill, profile?.state || null);
  } catch { /* best-effort */ }

  // Provider enrichment: NPPES lookup + audit metrics (non-blocking)
  const providerName = parsedBill.provider?.name || null;
  const providerNpi = parsedBill.provider?.npi || null;
  if (providerName || providerNpi) {
    try {
      // Find or match provider in providers table
      const { data: provider } = providerNpi
        ? await supabase.from("providers").select("id").eq("npi", providerNpi).maybeSingle()
        : await supabase.from("providers").select("id").ilike("name", `%${providerName}%`).limit(1).maybeSingle();

      if (provider?.id) {
        // NPPES enrichment (30-day cache, best-effort)
        const { lookupProvider } = await import("@/lib/care/provider-lookup");
        lookupProvider(supabase, provider.id).catch(() => {});

        // Provider audit metrics (best-effort)
        const { collectProviderAuditData } = await import("@/lib/care/provider-audit-metrics");
        collectProviderAuditData(
          supabase,
          provider.id,
          auditReport.findings.length,
          parsedBill.lineItems?.length || 0,
          auditReport.findings.map((f) => f.type)
        ).catch(() => {});
      }
    } catch { /* best-effort */ }
  }

  // Post-persist enrichment: backflow + code intelligence
  // Query persisted claim_line_items to get service_slugs (assigned by service-mapper during persist)
  if (claimId) {
    let persistedLineItems: Array<{
      billing_code: string | null;
      billing_code_type: string | null;
      service_slug: string | null;
      description: string | null;
      insurance_paid: number | null;
      billed_amount: number | null;
      patient_owes: number | null;
      adjustment_reason_code: string | null;
    }> = [];

    try {
      const { data: items } = await supabase
        .from("claim_line_items")
        .select("billing_code, billing_code_type, service_slug, description, insurance_paid, billed_amount, patient_owes, adjustment_reason_code")
        .eq("claim_id", claimId);
      persistedLineItems = items || [];
    } catch { /* continue without enrichment */ }

    // Backflow: bill costs → plan_covered_services (feature-flagged)
    if (insurancePlanId && persistedLineItems.length > 0) {
      try {
        const backflowEnabled = await isFeatureEnabled("claims_backflow", userEmail);
        if (backflowEnabled) {
          const { backflowBillCosts } = await import("@/lib/claims/backflow");
          await backflowBillCosts(supabase, {
            userId: doc.user_id,
            insurancePlanId,
            lineItems: persistedLineItems.map((li) => ({
              service_slug: li.service_slug,
              patient_owes: li.patient_owes,
              billed_amount: li.billed_amount,
            })),
          });
        }
      } catch (err) {
        console.error("[process-chunk] Backflow failed (non-fatal):", err);
      }
    }

    // Code intelligence: update billing_code_mappings + billing_code_plan_outcomes
    if (persistedLineItems.length > 0) {
      try {
        const { updateCodeMappings, updateCodeOutcomes } = await import("@/lib/claims/code-intelligence");
        await updateCodeMappings(supabase, persistedLineItems);

        // Get canonical plan ID for code outcome tracking
        if (insurancePlanId) {
          const { data: plan } = await supabase
            .from("insurance_plans")
            .select("matched_catalog_plan_id")
            .eq("id", insurancePlanId)
            .single();
          if (plan?.matched_catalog_plan_id) {
            await updateCodeOutcomes(supabase, persistedLineItems, plan.matched_catalog_plan_id);
          }
        }
      } catch (err) {
        console.error("[process-chunk] Code intelligence failed (non-fatal):", err);
      }
    }

    // Benefits utilization: auto-mark services as "used"
    if (insurancePlanId && persistedLineItems.length > 0) {
      try {
        const { updateBenefitsUsed } = await import("@/lib/claims/benefits-utilization");
        const slugs = persistedLineItems
          .map((li) => li.service_slug)
          .filter((s): s is string => s != null);
        if (slugs.length > 0) {
          await updateBenefitsUsed(supabase, {
            userId: doc.user_id,
            insurancePlanId,
            serviceSlugs: slugs,
          });
        }
      } catch (err) {
        console.error("[process-chunk] Benefits utilization failed (non-fatal):", err);
      }
    }

    // Claim matching: link related documents (EOB + bill for same service)
    try {
      const { matchRelatedClaims } = await import("@/lib/claims/claim-matching");
      const providerName = (parsedBill.provider?.name) || null;
      await matchRelatedClaims(supabase, {
        claimId,
        userId: doc.user_id,
        dateOfService: parsedBill.serviceDate || null,
        providerName,
      });
    } catch (err) {
      console.error("[process-chunk] Claim matching failed (non-fatal):", err);
    }

    // Discrepancy detection: three-tier coverage + cost + code substitution (feature-flagged)
    if (insurancePlanId) {
      try {
        const discrepancyEnabled = await isFeatureEnabled("eob_discrepancy_detection", userEmail);
        if (discrepancyEnabled) {
          const { detectDiscrepancies } = await import("@/lib/claims/discrepancy-engine");
          await detectDiscrepancies(supabase, {
            claimId,
            userId: doc.user_id,
            insurancePlanId,
          });
        }
      } catch (err) {
        console.error("[process-chunk] Discrepancy detection failed (non-fatal):", err);
      }
    }
  }

  // Update document status
  await supabase.from("documents").update({ status: "processed" }).eq("id", documentId);

  return {
    success: true,
    claimId: claimId || undefined,
    findings: auditReport.findings.length,
  };
}

const CONFIDENCE_HIGH = 0.8;
const CONFIDENCE_LOW = 0.4;

/**
 * Confidence-tiered type resolution:
 * - High (≥0.8): Haiku dictates pipeline type
 * - Medium (0.4-0.8): User's selection dictates type
 * - Low (<0.4): Halted — reject or queue for admin
 */
function resolveDocumentType(
  userType: string,
  haikuType: string,
  confidence: number,
): { effectiveType: string; skipCanonical: boolean; halt: boolean } {
  if (confidence < CONFIDENCE_LOW) {
    return { effectiveType: userType || haikuType, skipCanonical: true, halt: true };
  }
  if (confidence >= CONFIDENCE_HIGH) {
    return { effectiveType: haikuType, skipCanonical: false, halt: false };
  }
  // Medium: trust user, but hold canonical writes for plan docs
  return { effectiveType: userType || haikuType, skipCanonical: true, halt: false };
}

// Haiku extraction on large documents can take 15-30s.
// Vercel Hobby allows up to 60s with explicit maxDuration.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { documentId } = await req.json();
    if (!documentId) {
      return NextResponse.json({ error: "documentId required" }, { status: 400 });
    }

    const supabase = createServerClient();

    // Fetch document with current processing state
    const { data: doc, error: docError } = await supabase
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .single();

    if (docError || !doc) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    // Only process documents in the right state
    if (!["queued", "processing"].includes(doc.status)) {
      return NextResponse.json({ skip: true, reason: `Status is ${doc.status}` });
    }

    const step = doc.processing_step || "init";

    // ── STEP: INIT — download file, count pages, OCR first chunk ──────────
    if (step === "init") {
      // Concurrency guard: atomically claim this document
      const { data: claimed } = await supabase
        .from("documents")
        .update({
          status: "processing",
          processing_step: "working_init",
          processing_started_at: new Date().toISOString(),
        })
        .eq("id", documentId)
        .is("processing_step", null)
        .eq("status", "queued")
        .select("id");

      if (!claimed || claimed.length === 0) {
        return NextResponse.json({ skip: true, reason: "Already being processed" });
      }

      // Download file
      const { data: fileData, error: fileError } = await supabase.storage
        .from("documents")
        .download(doc.storage_path);

      if (fileError || !fileData) {
        await supabase.from("documents").update({ status: "error", processing_error: "Download failed" }).eq("id", documentId);
        return NextResponse.json({ error: "Download failed" }, { status: 500 });
      }

      const buffer = Buffer.from(await fileData.arrayBuffer());
      const totalPages = estimatePageCount(buffer);
      const totalChunks = Math.ceil(totalPages / CHUNK_SIZE);

      // Check processing budget before OCR
      const budget = await checkProcessingBudget(totalPages);
      if (!budget.allowed) {
        console.log(`[process-chunk] Budget exceeded: ${budget.reason}`);
        await supabase.from("documents").update({
          status: "error",
          processing_error: budget.reason || "Processing limit reached",
          processing_step: null,
        }).eq("id", documentId);
        return NextResponse.json({ error: budget.reason }, { status: 429 });
      }

      // OCR first chunk
      const chunks = await splitPDF(buffer, CHUNK_SIZE);
      const ocrResult = await extractTextFromDocument(chunks[0], "application/pdf");
      // Only record truly new pages (prevents double-counting on QStash retries)
      const prevCompleted = doc.processing_completed_pages || 0;
      const newPages = Math.max(0, Math.min(CHUNK_SIZE, totalPages) - prevCompleted);
      if (newPages > 0) await recordProcessingUsage(newPages);

      const nextStep = totalChunks > 1 ? "ocr_chunk_1" : "classifying";

      await supabase.from("documents").update({
        processing_step: nextStep,
        processing_total_pages: totalPages,
        processing_completed_pages: Math.min(CHUNK_SIZE, totalPages),
        processing_ocr_text: ocrResult.text,
      }).eq("id", documentId);

      // Chain next step via QStash (guaranteed delivery with retries)
      const baseUrl = new URL(req.url).origin;
      await enqueueChunk(documentId, baseUrl);

      return NextResponse.json({ step: nextStep, totalPages, completedPages: Math.min(CHUNK_SIZE, totalPages), continue: true });
    }

    // ── STEP: OCR_CHUNK_N — OCR the Nth chunk ─────────────────────────────
    const chunkMatch = step.match(/^ocr_chunk_(\d+)$/);
    if (chunkMatch) {
      const chunkIndex = parseInt(chunkMatch[1], 10);

      // Concurrency guard
      const { data: claimed } = await supabase
        .from("documents")
        .update({ processing_step: `working_ocr_chunk_${chunkIndex}`, processing_started_at: new Date().toISOString() })
        .eq("id", documentId)
        .eq("processing_step", step)
        .select("id");

      if (!claimed || claimed.length === 0) {
        return NextResponse.json({ skip: true, reason: "Already being processed" });
      }

      // Download and split
      const { data: fileData } = await supabase.storage.from("documents").download(doc.storage_path);
      if (!fileData) {
        await supabase.from("documents").update({ status: "error", processing_error: "Download failed" }).eq("id", documentId);
        return NextResponse.json({ error: "Download failed" }, { status: 500 });
      }

      const buffer = Buffer.from(await fileData.arrayBuffer());
      const chunks = await splitPDF(buffer, CHUNK_SIZE);

      if (chunkIndex >= chunks.length) {
        await supabase.from("documents").update({ processing_step: "classifying" }).eq("id", documentId);
        return NextResponse.json({ step: "classifying", continue: true });
      }

      // OCR this chunk
      const ocrResult = await extractTextFromDocument(chunks[chunkIndex], "application/pdf");
      const pagesInChunk = Math.min(CHUNK_SIZE, (doc.processing_total_pages || 0) - chunkIndex * CHUNK_SIZE);
      // Only record truly new pages (prevents double-counting on QStash retries)
      const chunkPrevCompleted = doc.processing_completed_pages || 0;
      const expectedAfter = (chunkIndex + 1) * CHUNK_SIZE;
      const chunkNewPages = Math.max(0, Math.min(pagesInChunk, expectedAfter - chunkPrevCompleted));
      if (chunkNewPages > 0) await recordProcessingUsage(chunkNewPages);

      const completedPages = (chunkIndex + 1) * CHUNK_SIZE;
      const isLastChunk = chunkIndex + 1 >= chunks.length;
      const nextStep = isLastChunk ? "classifying" : `ocr_chunk_${chunkIndex + 1}`;

      // Re-read latest OCR text to avoid clobbering concurrent writes
      const { data: latestDoc } = await supabase
        .from("documents")
        .select("processing_ocr_text")
        .eq("id", documentId)
        .single();

      const fullOcrText = (latestDoc?.processing_ocr_text || "") + ocrResult.text;

      await supabase.from("documents").update({
        processing_step: nextStep,
        processing_completed_pages: Math.min(completedPages, doc.processing_total_pages || completedPages),
        processing_ocr_text: fullOcrText,
      }).eq("id", documentId);

      if (!isLastChunk) {
        // More OCR chunks needed — enqueue via QStash
        const baseUrl = new URL(req.url).origin;
        await enqueueChunk(documentId, baseUrl);
        return NextResponse.json({ step: nextStep, completedPages, continue: true });
      }

      // Last OCR chunk — run classify + extract + save INLINE (no QStash handoff).
      // This avoids QStash response timeout issues on long Haiku calls.
      console.log(`[process-chunk] Last OCR chunk done. Running inline classify+extract+save...`);

      const { classifyWithHaiku } = await import("@/lib/classifier/haiku-classify");
      const classification = await classifyWithHaiku(fullOcrText, doc.file_name, doc.doc_type);

      if (!classification.isHealthcareDocument) {
        await supabase.from("documents").update({
          status: "error",
          processing_error: "This does not appear to be a healthcare document. Please upload an insurance plan, SBC, EOB, or medical bill.",
          classified_type: classification.classifiedType,
          classification_confidence: classification.confidence,
        }).eq("id", documentId);
        return NextResponse.json({ step: "rejected", continue: false });
      }

      // Confidence-tiered type resolution
      const userType = doc.doc_type;
      const haikuType = classification.classifiedType;
      const typeMismatch = userType && haikuType !== userType;
      const { effectiveType, skipCanonical, halt } = resolveDocumentType(userType, haikuType, classification.confidence);

      console.log(`[process-chunk] Type resolution: user="${userType}" haiku="${haikuType}" confidence=${classification.confidence.toFixed(2)} → effective="${effectiveType}" skipCanonical=${skipCanonical} halt=${halt}`);

      await supabase.from("documents").update({
        classified_type: effectiveType,
        classification_confidence: classification.confidence,
        type_mismatch: typeMismatch || false,
      }).eq("id", documentId);

      // Low confidence — halt processing, queue for admin review
      if (halt) {
        await supabase.from("documents").update({
          status: "pending_review",
          processing_error: "Low classification confidence. Queued for admin review.",
        }).eq("id", documentId);
        const { data: userForNotify } = await supabase.from("users").select("email").eq("firebase_uid", doc.user_id).single();
        notifyAdminForReview(documentId, haikuType, classification.confidence, doc.file_name, userForNotify?.email || "unknown").catch(() => {});
        return NextResponse.json({ step: "pending_review", continue: false, error: "Low confidence — queued for admin review" });
      }

      // Medium confidence — notify admin if there's a type mismatch (canonical held)
      if (skipCanonical && typeMismatch) {
        const { data: userForNotify } = await supabase.from("users").select("email").eq("firebase_uid", doc.user_id).single();
        notifyAdminForReview(documentId, haikuType, classification.confidence, doc.file_name, userForNotify?.email || "unknown").catch(() => {});
      }

      // Route by document type: bills → audit pipeline, plan docs → extraction pipeline
      if (BILL_TYPES.has(effectiveType)) {
        console.log(`[process-chunk] Bill detected (${effectiveType}). Running audit pipeline inline...`);
        const billResult = await processBillDocument(supabase, doc, fullOcrText, documentId, effectiveType);
        console.log(`[process-chunk] Bill result: success=${billResult.success}, findings=${billResult.findings}, claimId=${billResult.claimId}`);
        return NextResponse.json({ step: "done", continue: false, ...billResult });
      }

      const result = await processPlanDocumentData(
        supabase,
        { id: doc.id, user_id: doc.user_id, file_name: doc.file_name },
        fullOcrText,
        documentId,
        { classifiedType: effectiveType, confidence: classification.confidence, mismatch: typeMismatch || false },
        { skipCanonical }
      );

      console.log(`[process-chunk] Inline result: success=${result.success}, services=${result.servicesCreated}, skipCanonical=${skipCanonical}`);
      return NextResponse.json({ step: "done", continue: false, ...result });
    }

    // ── STEP: CLASSIFYING + EXTRACTING + SAVING (all inline) ──────────────
    // With Vercel Pro (maxDuration=60), we can run classify → extract → save
    // in a single invocation. No more QStash handoffs for these stages.
    if (step === "classifying" || step === "extracting" || step === "saving" || step === "parsing") {
      const { data: claimed } = await supabase
        .from("documents")
        .update({ processing_step: "working_classifying", processing_started_at: new Date().toISOString() })
        .eq("id", documentId)
        .eq("processing_step", step)
        .select("id");

      if (!claimed || claimed.length === 0) {
        return NextResponse.json({ skip: true, reason: "Already being processed" });
      }

      // Fresh read of OCR text
      const { data: freshDoc } = await supabase
        .from("documents")
        .select("processing_ocr_text")
        .eq("id", documentId)
        .single();
      const ocrText = freshDoc?.processing_ocr_text || "";

      // 1. Classify with Haiku
      console.log(`[process-chunk] Classifying with Haiku: ocrText length=${ocrText.length}`);
      const { classifyWithHaiku } = await import("@/lib/classifier/haiku-classify");
      const classification = await classifyWithHaiku(ocrText, doc.file_name, doc.doc_type);

      if (!classification.isHealthcareDocument) {
        console.log(`[process-chunk] Not a healthcare document — rejecting`);
        await supabase.from("documents").update({
          status: "error",
          processing_error: "This does not appear to be a healthcare document. Please upload an insurance plan, SBC, EOB, or medical bill.",
          classified_type: classification.classifiedType,
          classification_confidence: classification.confidence,
        }).eq("id", documentId);
        return NextResponse.json({ step: "rejected", continue: false, error: "Not a healthcare document" });
      }

      // Confidence-tiered type resolution
      const fallbackUserType = doc.doc_type;
      const fallbackHaikuType = classification.classifiedType;
      const fallbackMismatch = fallbackUserType && fallbackHaikuType !== fallbackUserType;
      const { effectiveType: fbEffectiveType, skipCanonical: fbSkipCanonical, halt: fbHalt } = resolveDocumentType(fallbackUserType, fallbackHaikuType, classification.confidence);

      console.log(`[process-chunk] Type resolution: user="${fallbackUserType}" haiku="${fallbackHaikuType}" confidence=${classification.confidence.toFixed(2)} → effective="${fbEffectiveType}" skipCanonical=${fbSkipCanonical} halt=${fbHalt}`);

      await supabase.from("documents").update({
        processing_step: "working_extracting",
        processing_started_at: new Date().toISOString(),
        classified_type: fbEffectiveType,
        classification_confidence: classification.confidence,
        type_mismatch: fallbackMismatch || false,
      }).eq("id", documentId);

      // Low confidence — halt
      if (fbHalt) {
        await supabase.from("documents").update({
          status: "pending_review",
          processing_error: "Low classification confidence. Queued for admin review.",
        }).eq("id", documentId);
        const { data: userForNotify } = await supabase.from("users").select("email").eq("firebase_uid", doc.user_id).single();
        notifyAdminForReview(documentId, fallbackHaikuType, classification.confidence, doc.file_name, userForNotify?.email || "unknown").catch(() => {});
        return NextResponse.json({ step: "pending_review", continue: false, error: "Low confidence — queued for admin review" });
      }

      // Medium confidence mismatch — notify admin
      if (fbSkipCanonical && fallbackMismatch) {
        const { data: userForNotify } = await supabase.from("users").select("email").eq("firebase_uid", doc.user_id).single();
        notifyAdminForReview(documentId, fallbackHaikuType, classification.confidence, doc.file_name, userForNotify?.email || "unknown").catch(() => {});
      }

      // Route by document type
      if (BILL_TYPES.has(fbEffectiveType)) {
        console.log(`[process-chunk] Bill detected (${fbEffectiveType}). Running audit pipeline...`);
        const billResult = await processBillDocument(supabase, doc, ocrText, documentId, fbEffectiveType);
        console.log(`[process-chunk] Bill result: success=${billResult.success}, findings=${billResult.findings}, claimId=${billResult.claimId}`);
        return NextResponse.json({ step: "done", continue: false, ...billResult });
      }

      const result = await processPlanDocumentData(
        supabase,
        { id: doc.id, user_id: doc.user_id, file_name: doc.file_name },
        ocrText,
        documentId,
        { classifiedType: fbEffectiveType, confidence: classification.confidence, mismatch: fallbackMismatch || false },
        { skipCanonical: fbSkipCanonical }
      );

      console.log(`[process-chunk] Result: success=${result.success}, services=${result.servicesCreated}, skipCanonical=${fbSkipCanonical}`);

      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 500 });
      }

      return NextResponse.json({ step: "done", continue: false, ...result });
    }

    // Working state — a step is in progress, check if it's stale
    if (step.startsWith("working_")) {
      const startedAt = doc.processing_started_at ? new Date(doc.processing_started_at).getTime() : 0;
      const staleMins = (Date.now() - startedAt) / 60000;
      if (staleMins > 2) {
        // Stale working state — reset to the step it was working on
        const originalStep = step.replace("working_", "");
        await supabase.from("documents").update({
          processing_step: originalStep === "init" ? null : originalStep,
          status: originalStep === "init" ? "queued" : "processing",
        }).eq("id", documentId);
        // Re-enqueue recovered step
        const baseUrl = new URL(req.url).origin;
        await enqueueChunk(documentId, baseUrl);
        return NextResponse.json({ recovered: true, step: originalStep });
      }
      return NextResponse.json({ skip: true, reason: `Step ${step} in progress` });
    }

    return NextResponse.json({ skip: true, reason: `Unknown step: ${step}` });

  } catch (error) {
    console.error("[process-chunk] Error:", error);
    return NextResponse.json({ error: "Processing chunk failed" }, { status: 500 });
  }
}
