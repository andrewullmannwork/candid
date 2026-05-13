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
import { processPlanDocumentData, type ProcessPlanResult } from "@/lib/plan/process-plan";
import { processEOCDocumentData } from "@/lib/plan/process-eoc";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { parseBillFromOCR } from "@/lib/billing/parser";
import { parseBillWithHaiku } from "@/lib/billing/haiku-bill-parser";
import { runAudit } from "@/lib/audit";
import { collectPricingData } from "@/lib/care/collector";
import { checkProcessingBudget, recordProcessingUsage } from "@/lib/config/processing-usage";
import { enqueueChunk } from "@/lib/queue/qstash";
import { notifyAdminForReview } from "@/lib/notifications";

const CHUNK_SIZE = 15; // pages per OCR chunk

const BILL_TYPES = new Set(["eob", "itemized_bill"]);

// Phase 3.1A — image-PDF refusal threshold per Q-P3.1A-12 LOCK.
// EOCs need ≥500 chars of text-extracted content for the EOC parser to function
// meaningfully. Below this threshold likely indicates an image-only PDF where pdftotext
// returned blanks/scraps; OCR cost would be ~$15/EOC for 150 pages — exceeds the $1
// hard cap (Q-P3.1A-6) by 15×. Prompt user to upload text-extractable version.
const EOC_MIN_TEXT_CHARS = 500;

// Bundle PR #1 (Session 55, audit item #17) — image-PDF refusal threshold for SBC.
// Smallest legitimate SBC fixture in tests/fixtures/sbcs/ is 15,352 chars; 500-char
// threshold leaves ~3% safety margin. Below this likely indicates a scanned-image
// SBC where pdftotext returned blanks; Haiku would emit confident-but-wrong values
// from garbage OCR. Prompt user to upload text-extractable version (mirrors EOC
// pattern at lines 295-309).
const SBC_MIN_TEXT_CHARS = 500;

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

  // F-2 — resolve plan + load coverage BEFORE runAudit so missing_adjustment
  // + insurance_underpayment rules can compute should_owe against plan terms
  // on the very first audit. Without this, brand-new uploads would surface
  // contractual-writeoff numbers instead of user-recovery numbers until D7
  // re-fires on next view.
  const { isFeatureEnabled } = await import("@/lib/config/product-flags");
  const { data: userForFlag } = await supabase.from("users").select("email").eq("firebase_uid", doc.user_id).single();
  const userEmail = userForFlag?.email || undefined;

  const { data: profile } = await supabase
    .from("profiles")
    .select("active_insurance_plan_id, state")
    .eq("user_id", doc.user_id)
    .single();

  // T3.7: Resolve the plan that was active on the bill's date of service —
  // NOT the user's currently-active plan. Falls back to active plan only if
  // no historical plan matches the DOS window or year.
  const { resolveClaimPlanContext } = await import("@/lib/claims/plan-year-resolver");
  const { planId: insurancePlanId, planYear } = await resolveClaimPlanContext(supabase, {
    userId: doc.user_id,
    dateOfService: parsedBill.serviceDate || null,
    fallbackActivePlanId: profile?.active_insurance_plan_id || null,
  });

  const { loadCoverageMapForPlan } = await import("@/lib/audit/coverage-loader");
  const planCoverage = await loadCoverageMapForPlan(supabase, insurancePlanId);

  const auditReport = await runAudit(parsedBill, planCoverage);

  // Persist claims (feature-flagged)
  let claimId: string | null = null;
  try {
    const claimsEnabled = await isFeatureEnabled("claims_persistence", userEmail);
    if (claimsEnabled) {
      const { persistAuditResults } = await import("@/lib/claims/persist");
      const persistResult = await persistAuditResults(supabase, {
        userId: doc.user_id,
        insurancePlanId: insurancePlanId || undefined,
        planYear,
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
            await updateCodeOutcomes(supabase, persistedLineItems, plan.matched_catalog_plan_id, planYear);
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

  // S78 — async ingestion: fire parse-complete email for large docs. Fail-soft;
  // the helper internally gates on pageCount > 30 + uses Resend idempotency key
  // (parse-complete:{documentId}) so QStash retries can't double-send.
  try {
    const { sendParseCompleteEmail } = await import("@/lib/email/onboarding-emails");
    await sendParseCompleteEmail(supabase, documentId);
  } catch (err) {
    console.error("[process-chunk] parse-complete email (non-fatal):", err);
  }

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
/**
 * Phase 3.1A — dispatcher for plan-doc OR EOC processing.
 *
 * Three responsibilities:
 *   1. Image-PDF refusal (Q-P3.1A-12 LOCK): if classifiedType=='eoc' AND ocrText is
 *      degraded (<EOC_MIN_TEXT_CHARS), mark document rejected_image_eoc + surface
 *      UI prompt; do NOT invoke EOC parser (cost ceiling per Q-P3.1A-6).
 *   2. Feature-flag gate (Q-P3.1A-10 LOCK): if classifiedType=='eoc' AND
 *      eoc_parser_v1 flag OFF for this user, fall through to legacy plan-doc-parser
 *      (gives plan-identity extraction without EOC-specific section parsing).
 *   3. Otherwise: invoke processPlanDocumentData (existing legacy path) for sbc,
 *      plan_document, and EOC-with-flag-OFF.
 */
async function dispatchPlanOrEOC(args: {
  supabase: ReturnType<typeof createServerClient>;
  doc: { id: string; user_id: string; file_name: string };
  ocrText: string;
  documentId: string;
  classification: { classifiedType: string; confidence: number; mismatch: boolean };
  skipCanonical: boolean;
}): Promise<ProcessPlanResult> {
  const { supabase, doc, ocrText, documentId, classification, skipCanonical } = args;

  if (classification.classifiedType === "eoc") {
    // 1. Image-PDF refusal per Q-P3.1A-12 LOCK.
    if (ocrText.length < EOC_MIN_TEXT_CHARS) {
      const reason = `EOC document appears to be a scanned image (only ${ocrText.length} chars of text extracted). Please upload a text-based PDF version from your insurer's portal for accurate processing.`;
      console.warn(`[process-chunk] ${reason} (documentId=${documentId})`);
      await supabase
        .from("documents")
        .update({
          status: "error",
          processing_error: reason,
          processing_step: "rejected_image_eoc",
        })
        .eq("id", documentId);
      return { success: false, error: reason, parseWarnings: [reason] };
    }

    // 2. Feature-flag gate per Q-P3.1A-10 LOCK.
    const { data: userForFlag } = await supabase
      .from("users")
      .select("email")
      .eq("firebase_uid", doc.user_id)
      .maybeSingle();
    const eocEnabled = await isFeatureEnabled("eoc_parser_v1", userForFlag?.email || undefined);

    if (eocEnabled) {
      console.log(`[process-chunk] EOC parser v1 ENABLED for user. Routing to processEOCDocumentData.`);
      return processEOCDocumentData(supabase, { doc, ocrText, documentId, classification });
    }

    // Flag OFF — fall through to legacy plan-doc-parser path so EOC docs still get
    // plan-identity extraction. Coerce classifiedType to 'plan_document' for the
    // legacy classifier branch (since processPlanDocumentData uses isFullPlanDoc=true
    // for plan_document AND eoc with current logic).
    console.log(`[process-chunk] EOC parser v1 DISABLED for user. Falling back to legacy plan-doc-parser.`);
    return processPlanDocumentData(
      supabase,
      doc,
      ocrText,
      documentId,
      { ...classification, classifiedType: "plan_document" },
      { skipCanonical },
    );
  }

  // Bundle PR #1 (Session 55, audit item #17) — image-PDF refusal for SBC.
  // EOC has analogous refusal above; SBC was unprotected. Without this, scanned-image
  // SBCs hit Haiku with garbage OCR and produce confident-but-wrong values that
  // poison the canonical seed. T0.4 retry button surfaces the explicit error to user.
  if (classification.classifiedType === "sbc" && ocrText.length < SBC_MIN_TEXT_CHARS) {
    const reason = `SBC document appears to be a scanned image (only ${ocrText.length} chars of text extracted). Please upload a text-based PDF version from your insurer's portal for accurate processing.`;
    console.warn(`[process-chunk] ${reason} (documentId=${documentId})`);
    await supabase
      .from("documents")
      .update({
        status: "error",
        processing_error: reason,
        processing_step: "rejected_image_sbc",
      })
      .eq("id", documentId);
    return { success: false, error: reason, parseWarnings: [reason] };
  }

  // Non-EOC types: existing legacy path.
  return processPlanDocumentData(supabase, doc, ocrText, documentId, classification, { skipCanonical });
}

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

      // Phase 3.1A — EOC dispatch with image-PDF refusal + feature-flag gate.
      const result = await dispatchPlanOrEOC({
        supabase,
        doc,
        ocrText: fullOcrText,
        documentId,
        classification: { classifiedType: effectiveType, confidence: classification.confidence, mismatch: typeMismatch || false },
        skipCanonical,
      });

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

      // Phase 3.1A — EOC dispatch with image-PDF refusal + feature-flag gate.
      const fbResult = await dispatchPlanOrEOC({
        supabase,
        doc,
        ocrText,
        documentId,
        classification: { classifiedType: fbEffectiveType, confidence: classification.confidence, mismatch: fallbackMismatch || false },
        skipCanonical: fbSkipCanonical,
      });

      console.log(`[process-chunk] Fallback result: success=${fbResult.success}, services=${fbResult.servicesCreated}, skipCanonical=${fbSkipCanonical}`);
      return NextResponse.json({ step: "done", continue: false, ...fbResult });
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
