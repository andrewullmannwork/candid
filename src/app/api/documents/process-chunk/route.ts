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
 *   classifying       → Haiku classify + extract + save (all inline, maxDuration=800) → processed
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { extractTextFromDocument } from "@/lib/ocr";
import { splitPDF, estimatePageCount } from "@/lib/ocr/document-ai";
import { assessAdversarialPdf } from "@/lib/parser/adversarial-pdf-ingest";
import { computeContentFingerprint } from "@/lib/parser/id-block/content-fingerprint";
import { processPlanDocumentData, type ProcessPlanResult } from "@/lib/plan/process-plan";
import { processEOCDocumentData } from "@/lib/plan/process-eoc";
import { resolvePlanFamilyDispatch } from "@/lib/documents/plan-family-dispatch";
import type { EocParseState } from "@/lib/plan/eoc-resume";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { getUserContextByPk } from "@/lib/users/resolve-user-by-pk";
import { parseBillFromOCR } from "@/lib/billing/parser";
import { parseBillWithHaiku } from "@/lib/billing/haiku-bill-parser";
import { runAudit } from "@/lib/audit";
import { collectPricingData } from "@/lib/care/collector";
import { checkProcessingBudget, recordProcessingUsage } from "@/lib/config/processing-usage";
import { enqueueChunk } from "@/lib/queue/qstash";
import { notifyAdminForReview } from "@/lib/notifications";
import { Receiver } from "@upstash/qstash";

// Strict signature verification on Vercel deploys (Preview + Production).
// Local dev (no VERCEL_ENV) keeps working via the qstash.ts direct-fetch
// fallback for `npm run dev` document processing.
const IS_VERCEL_DEPLOY = !!process.env.VERCEL_ENV;

let _qstashReceiver: Receiver | null | undefined = undefined;
function getQStashReceiver(): Receiver | null {
  if (_qstashReceiver !== undefined) return _qstashReceiver;
  const current = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const next = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!current || !next) {
    _qstashReceiver = null;
    return null;
  }
  _qstashReceiver = new Receiver({
    currentSigningKey: current,
    nextSigningKey: next,
  });
  return _qstashReceiver;
}

const CHUNK_SIZE = 15; // pages per OCR chunk

const BILL_TYPES = new Set(["eob", "itemized_bill"]);

/**
 * B12 — infer MIME type from a Supabase storage path's file extension.
 * Returns the image MIME type when the path is a recognized image format;
 * null otherwise (PDF or unknown, which flows through the PDF pipeline).
 *
 * HEIC inputs are converted to JPEG at upload time (upload/route.ts),
 * so .heic / .heif should not appear in storage_path in practice — but we
 * map them defensively in case of legacy rows or future migration.
 */
function inferImageMimeType(storagePath: string): string | null {
  const ext = storagePath.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    default:
      return null;
  }
}

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
  const userForFlag = await getUserContextByPk(supabase, doc.user_id, "process-chunk:processBillDocument:claims_persistence");
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

  const { loadCoverageMapForPlan, loadAcaFallbackForAudit } = await import("@/lib/audit/coverage-loader");
  const planCoverage = await loadCoverageMapForPlan(supabase, insurancePlanId);

  // S74.6 §C.1 — pre-flight slug resolution BEFORE runAudit. Runs the
  // flywheel + legacy service-mapper paths, mutates bill.lineItems[i].
  // serviceSlug + .billingCodeIdentityId so the audit pipeline can build
  // per-slug cohort keys + D4 skips already-categorized lines. persist
  // consumes these without re-resolving.
  const { resolveLineItemSlugs } = await import("@/lib/claims/preflight-slug-resolver");
  await resolveLineItemSlugs(supabase, doc.user_id, parsedBill);

  // S74.6 D3 — thread insurer_name so runAudit can apply cohort accuracy
  // adjustment (boost / informational chip / suppress per Subplan §B).
  let insurerNameForAudit: string | null = null;
  let patientNameForAcaFallback: string | null = null;
  if (insurancePlanId) {
    const { data: planRow } = await supabase
      .from("insurance_plans")
      .select("insurer_name")
      .eq("id", insurancePlanId)
      .maybeSingle();
    insurerNameForAudit = (planRow?.insurer_name as string | null) ?? null;
  }
  // ACA fallback needs the patient name to match demographics (multi-member
  // family plan). Bill may carry it on the parsed shape; otherwise the helper
  // tolerates null (falls back to primary subscriber demographics).
  patientNameForAcaFallback =
    (parsedBill as { patientName?: string | null }).patientName ?? null;

  // S74.6 D2 §B — load ACA-mandated zero-cost-share fallback for audit. ACA
  // bySlug merges INTO planCoverage (existing plan rows win — registry only
  // fires on plan miss); byLineNumber threaded separately so slug-less lines
  // (D4 hasn't bound yet) still see coverage in F-13 + F-14 rules.
  const acaFallback = await loadAcaFallbackForAudit({
    supabase,
    planId: insurancePlanId,
    userId: doc.user_id,
    patientName: patientNameForAcaFallback,
    bill: parsedBill,
    existingCoverageBySlug: new Set(planCoverage?.keys() ?? []),
  });
  const mergedPlanCoverage = planCoverage ?? new Map();
  for (const [slug, cov] of acaFallback.bySlug) {
    if (!mergedPlanCoverage.has(slug)) mergedPlanCoverage.set(slug, cov);
  }

  const auditReport = await runAudit(
    parsedBill,
    mergedPlanCoverage.size > 0 ? mergedPlanCoverage : null,
    { insurerName: insurerNameForAudit },
    acaFallback.byLineNumber,
  );

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
 * The ROUTING DECISION is the pure `resolvePlanFamilyDispatch`
 * (`src/lib/documents/plan-family-dispatch.ts`) — flag precedence, image-PDF
 * refusal floors, and the unified/legacy coercion contract live there with a
 * fixture-backed truth table (incl. the S195 fix: `eoc_parser_v1` ON now wins
 * over the `unified_plan_doc_parser_v1` short-circuit that had made the EOC
 * parser unreachable in PROD). This wrapper owns the I/O: flag lookups, the
 * refusal DB writes + log lines, and the parser invocations.
 */
async function dispatchPlanOrEOC(args: {
  supabase: ReturnType<typeof createServerClient>;
  doc: { id: string; user_id: string; file_name: string };
  ocrText: string;
  documentId: string;
  classification: { classifiedType: string; confidence: number; mismatch: boolean };
  skipCanonical: boolean;
  /** Origin for the EOC parser's QStash self-re-enqueue (S195 EOC-RESUME). */
  baseUrl: string;
}): Promise<ProcessPlanResult> {
  const { supabase, doc, ocrText, documentId, classification, skipCanonical, baseUrl } = args;

  const planDocFamily =
    classification.classifiedType === "sbc" ||
    classification.classifiedType === "eoc" ||
    classification.classifiedType === "plan_document";
  if (planDocFamily) {
    // One user-context fetch feeds both flag lookups (pre-S195 each branch did
    // its own fetch of the same column — read-only, op-equivalent).
    const userCtx = await getUserContextByPk(supabase, doc.user_id, "process-chunk:plan-family-dispatch");
    const email = userCtx?.email || undefined;
    const unifiedEnabled = await isFeatureEnabled("unified_plan_doc_parser_v1", email);
    const eocParserEnabled =
      classification.classifiedType === "eoc"
        ? await isFeatureEnabled("eoc_parser_v1", email)
        : false;

    const decision = resolvePlanFamilyDispatch({
      classifiedType: classification.classifiedType,
      ocrTextLength: ocrText.length,
      unifiedEnabled,
      eocParserEnabled,
      sbcMinTextChars: SBC_MIN_TEXT_CHARS,
      eocMinTextChars: EOC_MIN_TEXT_CHARS,
    });

    if (decision.route === "reject_image_eoc") {
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
    if (decision.route === "reject_image_sbc") {
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
    if (decision.route === "eoc_parser") {
      console.log(`[process-chunk] EOC parser v1 ENABLED for user. Routing to processEOCDocumentData.`);
      return processEOCDocumentData(supabase, { doc, ocrText, documentId, classification, baseUrl });
    }
    // decision.route === "plan_doc_parser"
    if (decision.via === "unified") {
      console.log(
        `[process-chunk] unified_plan_doc_parser_v1 ON — routing ${classification.classifiedType} through plan_doc parser`,
      );
    } else if (decision.via === "eoc_flag_off") {
      console.log(`[process-chunk] EOC parser v1 DISABLED for user. Falling back to legacy plan-doc-parser.`);
    }
    return processPlanDocumentData(
      supabase,
      doc,
      ocrText,
      documentId,
      decision.coerceToPlanDocument
        ? { ...classification, classifiedType: "plan_document" }
        : classification,
      { skipCanonical },
    );
  }

  // Non-family types (defensive — process-chunk only calls this for the family):
  // existing legacy path, classification untouched.
  return processPlanDocumentData(supabase, doc, ocrText, documentId, classification, { skipCanonical });
}

/**
 * S101 — Smart-skip Haiku extraction via canonical match.
 *
 * Moved here from upload route to unblock the upload response (was adding
 * 10-20s of Haiku identifier extraction inline before the response could
 * return). The user now sees "Page 0 of N" within ~3-5s of upload; this
 * check fires AFTER OCR chunk 0 completes in the init step of the chunk
 * processor, BEFORE any subsequent OCR chunks or Haiku classification.
 *
 * Smart-skip cost savings preserved 1:1 — when a stable canonical match is
 * found, `linkDocumentToCanonical` fires (creates user's insurance_plans +
 * plan_covered_services rows from canonical data, marks doc processed),
 * skipping the full Haiku parse (~$0.10-0.50 saved per skip).
 *
 * Returns:
 *   - `{ skipped: true, ... }` — smart-skip hit; doc.status = "processed"
 *     after linkDocumentToCanonical. Caller should return success without
 *     enqueueing further chunks.
 *   - `{ skipped: false, reason }` — no smart-skip; caller continues normal
 *     OCR/parse flow.
 *
 * Failure modes (all fall back to normal pipeline):
 *   - doc.classified_type not plan-document family
 *   - doc.file_hash null (shouldn't happen post-upload-insert)
 *   - document_dedup flag off
 *   - shouldSkipExtraction returns skip=false (no stable canonical match)
 *   - linkDocumentToCanonical fails (logs warning, falls through)
 *   - thrown error (logged, falls through)
 */
async function runSmartSkipCheck(args: {
  supabase: SupabaseClient;
  doc: {
    id: string;
    user_id: string;
    file_name: string;
    file_hash: string | null;
    classified_type: string | null;
  };
  ocrText: string;
}): Promise<
  | { skipped: true; canonicalPlanId: string; reason: string; servicesCreated: number }
  | { skipped: false; reason: string }
> {
  const { supabase, doc, ocrText } = args;
  try {
    const isPlanDoc =
      doc.classified_type === "sbc" ||
      doc.classified_type === "plan_document" ||
      doc.classified_type === "eoc";
    if (!isPlanDoc) return { skipped: false, reason: "not_plan_doc" };
    if (!doc.file_hash) return { skipped: false, reason: "missing_file_hash" };

    const userForFlag = await getUserContextByPk(supabase, doc.user_id, "process-chunk:runSmartSkipCheck:document_dedup");
    const dedupEnabled = await isFeatureEnabled(
      "document_dedup",
      userForFlag?.email || undefined,
    );
    if (!dedupEnabled) return { skipped: false, reason: "dedup_disabled" };

    const { extractPlanIdentifiers, extractPlanIdentifiersWithHaiku, shouldSkipExtraction, linkDocumentToCanonical } =
      await import("@/lib/plan/extraction-dedup");

    let identifiers = extractPlanIdentifiers(ocrText);
    if (!identifiers.insurer || !identifiers.planName) {
      identifiers = await extractPlanIdentifiersWithHaiku(ocrText);
    }

    // doc.classified_type narrowed by isPlanDoc check above (sbc/plan_document/eoc).
    // Cast satisfies shouldSkipExtraction's ClassifiedDocType signature.
    const dedupResult = await shouldSkipExtraction(
      supabase,
      doc.id,
      doc.file_hash,
      identifiers,
      doc.user_id,
      doc.classified_type as "sbc" | "plan_document" | "eoc",
    );
    console.log(
      `[process-chunk] Smart-skip check: skip=${dedupResult.skip}, reason=${dedupResult.reason}, identifiers=${identifiers.source}`,
    );

    if (!dedupResult.skip || !dedupResult.canonicalPlanId) {
      // Ing-D.0c-ii — persist the Layer-5 forced-reparse reason (if any) so the
      // later record-step (recordParseEventV4, a separate QStash invocation) can
      // drive verification-mode open/resolve. Written ONLY when set (cf40_v4
      // flag ON + a forced re-parse), so the flag-OFF path stays byte-identical.
      // Non-fatal.
      if (dedupResult.forcedReparseReason) {
        try {
          await supabase
            .from("documents")
            .update({ cf40_forced_reparse_reason: dedupResult.forcedReparseReason })
            .eq("id", doc.id);
        } catch (persistErr) {
          console.warn(
            "[process-chunk] cf40_forced_reparse_reason persist failed (non-fatal):",
            persistErr,
          );
        }
      }
      return { skipped: false, reason: dedupResult.reason };
    }

    const result = await linkDocumentToCanonical(
      supabase,
      { id: doc.id, user_id: doc.user_id, file_name: doc.file_name },
      dedupResult.canonicalPlanId,
      ocrText,
      identifiers,
      // mig 218 — inherit the traced link's confidence; never mint one here.
      dedupResult.canonicalMatchConfidence ?? null,
    );

    if (!result.success) {
      console.warn(
        `[process-chunk] Smart-skip link failed: ${result.error}. Falling through to normal pipeline.`,
      );
      return { skipped: false, reason: `link_failed:${result.error ?? "unknown"}` };
    }

    console.log(
      `[process-chunk] Smart-skip linked doc ${doc.id} to canonical ${dedupResult.canonicalPlanId}. Services created: ${result.servicesCreated}`,
    );
    return {
      skipped: true,
      canonicalPlanId: dedupResult.canonicalPlanId,
      reason: dedupResult.reason,
      servicesCreated: result.servicesCreated ?? 0,
    };
  } catch (err) {
    console.error("[process-chunk] Smart-skip check threw (non-fatal):", err);
    return { skipped: false, reason: "exception" };
  }
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
// Vercel Pro allows up to 800s with explicit maxDuration. Bumped from 300 → 800
// at S97 to handle large-EOC (72+ page) plan_doc inline classify+extract+save
// invocations that hit the 5-min ceiling. The architectural fix — splitting the
// classifying step into QStash-chained sub-steps so each Haiku call fits within
// a single function invocation — lives in the B14 work block. 800s is the Pro
// plan max; bigger EOCs (200+ pages) will still need the split-step architecture.
export const maxDuration = 800;

export async function POST(req: NextRequest) {
  // S320 — visible to the outer catch so an unhandled throw can terminate the
  // document instead of stranding it: the claim guard means a crashed step is
  // never re-claimed by QStash retries, so without this write the doc sits in
  // working_* forever (the E2E "Final Steps" eternal spinner) while every
  // retry layer (in-route stale recovery, upload-time reset, retry-stuck cron)
  // faithfully re-runs a deterministic crash.
  let documentIdForFailure: string | null = null;
  try {
    // Read raw body BEFORE JSON.parse — QStash signature is computed over
    // the exact bytes sent. JSON.parse + re-serialize would change them.
    const rawBody = await req.text();

    if (IS_VERCEL_DEPLOY) {
      const receiver = getQStashReceiver();
      if (!receiver) {
        // Fail-closed: signing keys MUST be configured in any Vercel deploy.
        console.error("[process-chunk] FATAL: QSTASH signing keys missing in Vercel deploy");
        return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
      }
      const signature = req.headers.get("upstash-signature");
      if (!signature) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      try {
        const valid = await receiver.verify({
          signature,
          body: rawBody,
          url: req.url,
        });
        if (!valid) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      } catch (verifyErr) {
        console.warn("[process-chunk] QStash signature verification failed:", verifyErr);
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    } else {
      console.warn("[process-chunk] QStash signature verification skipped — running outside Vercel deploy");
    }

    const { documentId } = JSON.parse(rawBody) as { documentId?: string };
    if (!documentId) {
      return NextResponse.json({ error: "documentId required" }, { status: 400 });
    }
    documentIdForFailure = documentId;

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

    // ── S195 EOC-RESUME short-circuit ─────────────────────────────────────
    // A doc carrying live checkpoint state is a multi-invocation EOC parse in
    // flight: jump straight back into the driver — no re-classification (the
    // type was settled when the run started; re-classifying would cost a
    // Haiku call per invocation and risk mid-run type flap). Keyed on the
    // state blob (not processing_step) so QStash retries of the ORIGINAL
    // classify message land here too; the driver's heartbeat guard dedupes
    // concurrent deliveries. Rollback semantics: eoc_parser_v1 OFF mid-run
    // aborts the resume loudly instead of finishing a parse the operator
    // turned off.
    {
      const resumeState = (doc.metadata as Record<string, unknown> | null)
        ?.eoc_parse_state as EocParseState | undefined;
      if (doc.status === "processing" && resumeState?.version === 1) {
        const userForResume = await getUserContextByPk(supabase, doc.user_id, "process-chunk:eoc-resume");
        const eocStillEnabled = await isFeatureEnabled("eoc_parser_v1", userForResume?.email || undefined);
        if (!eocStillEnabled) {
          const reason = "eoc_resume_aborted_flag_off";
          console.warn(`[process-chunk] ${reason} (documentId=${documentId})`);
          const meta = { ...((doc.metadata as Record<string, unknown> | null) ?? {}) };
          delete meta.eoc_parse_state;
          await supabase
            .from("documents")
            .update({ status: "error", processing_error: reason, metadata: meta })
            .eq("id", documentId);
          return NextResponse.json({ step: "eoc_resume_aborted", continue: false, error: reason });
        }
        const resumeResult = await processEOCDocumentData(supabase, {
          doc: { id: doc.id, user_id: doc.user_id, file_name: doc.file_name },
          ocrText: doc.processing_ocr_text || "",
          documentId,
          classification: {
            classifiedType: "eoc",
            confidence: (doc.classification_confidence as number | null) ?? 0.95,
            mismatch: (doc.type_mismatch as boolean | null) ?? false,
          },
          baseUrl: new URL(req.url).origin,
        });
        console.log(
          `[process-chunk] EOC resume invocation: success=${resumeResult.success}, resumeRequested=${resumeResult.resumeRequested === true}`,
        );
        return NextResponse.json({
          step: resumeResult.resumeRequested ? "eoc_resume_pending" : "done",
          continue: resumeResult.resumeRequested === true,
          ...resumeResult,
        });
      }
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

      // B12 — image-upload short-circuit. The PDF pipeline below
      // (estimatePageCount, splitPDF, chunked OCR) assumes PDF bytes and
      // fails on raw image buffers. For JPEG / PNG / WebP / etc. uploads,
      // run a single OCR pass + jump straight to the classifying step.
      // HEIC inputs are converted to JPEG at upload time (B12 — see
      // upload/route.ts) so .heic never reaches storage in practice.
      const imageMimeType = inferImageMimeType(doc.storage_path);
      if (imageMimeType) {
        // Budget gate — treat the image as 1 page.
        const imgBudget = await checkProcessingBudget(1);
        if (!imgBudget.allowed) {
          console.log(`[process-chunk] Image budget exceeded: ${imgBudget.reason}`);
          await supabase.from("documents").update({
            status: "error",
            processing_error: imgBudget.reason || "Processing limit reached",
            processing_step: null,
          }).eq("id", documentId);
          return NextResponse.json({ error: imgBudget.reason }, { status: 429 });
        }

        const imgOcrResult = await extractTextFromDocument(buffer, imageMimeType);
        await recordProcessingUsage(1);

        await supabase.from("documents").update({
          processing_step: "classifying",
          processing_total_pages: 1,
          processing_completed_pages: 1,
          processing_ocr_text: imgOcrResult.text,
        }).eq("id", documentId);

        // Chain into the classify step. Same QStash enqueue pattern as the
        // PDF path uses between chunks — guaranteed-delivery transition.
        const imgBaseUrl = new URL(req.url).origin;
        await enqueueChunk(documentId, imgBaseUrl);

        return NextResponse.json({
          step: "classifying",
          totalPages: 1,
          completedPages: 1,
          continue: true,
        });
      }

      let totalPages = await estimatePageCount(buffer);
      let totalChunks = Math.ceil(totalPages / CHUNK_SIZE);

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
      const split = await splitPDF(buffer, CHUNK_SIZE);
      const ocrResult = await extractTextFromDocument(split.chunks[0], "application/pdf");
      // S320 — degraded split = pdf-lib couldn't parse; chunk 0 IS the whole
      // document and the OCR engine just read every page. Align the totals to
      // what was actually read so no phantom chunk pass is ever enqueued.
      if (split.degraded) {
        totalPages = ocrResult.pages.length || totalPages;
        totalChunks = 1;
        console.warn(
          `[process-chunk] degraded split: whole-document OCR, ${totalPages} pages in one pass (doc ${documentId})`,
        );
      }
      const chunk0Pages = split.degraded ? totalPages : Math.min(CHUNK_SIZE, totalPages);
      // Only record truly new pages (prevents double-counting on QStash retries)
      const prevCompleted = doc.processing_completed_pages || 0;
      const newPages = Math.max(0, chunk0Pages - prevCompleted);
      if (newPages > 0) await recordProcessingUsage(newPages);

      // Ing-G.2/3 — adversarial-PDF assessment (flag-gated; non-fatal; idempotent).
      // Runs on the full original PDF before smart-skip + Haiku, so every doc is
      // scored even when extraction is later skipped. Writes documents.metadata.
      await assessAdversarialPdf(supabase, documentId, buffer);

      // S101 — smart-skip check (moved from upload route). OCR chunk 0 gives
      // us 15 pages of pdfjs-extracted text — plenty for identifier regex.
      // If matched to a stable canonical, link + mark processed and skip
      // remaining OCR + Haiku parse. Cost savings preserved 1:1.
      const smartSkipResult = await runSmartSkipCheck({
        supabase,
        doc: {
          id: doc.id,
          user_id: doc.user_id,
          file_name: doc.file_name,
          file_hash: doc.file_hash,
          classified_type: doc.classified_type,
        },
        ocrText: ocrResult.text,
      });

      if (smartSkipResult.skipped) {
        // linkDocumentToCanonical set status=processed. Also persist the
        // page count + OCR text so /api/documents/status returns sensible
        // numbers (frontend sub-phase machine renders "Page X of N" using
        // totalPages from polling).
        await supabase
          .from("documents")
          .update({
            processing_total_pages: totalPages,
            processing_completed_pages: totalPages,
            processing_ocr_text: ocrResult.text,
          })
          .eq("id", documentId);
        return NextResponse.json({
          step: "done",
          skippedExtraction: true,
          dedupReason: smartSkipResult.reason,
          canonicalPlanId: smartSkipResult.canonicalPlanId,
          servicesCreated: smartSkipResult.servicesCreated,
          totalPages,
          completedPages: totalPages,
        });
      }

      const nextStep = totalChunks > 1 ? "ocr_chunk_1" : "classifying";

      await supabase.from("documents").update({
        processing_step: nextStep,
        processing_total_pages: totalPages,
        processing_completed_pages: chunk0Pages,
        processing_ocr_text: ocrResult.text,
      }).eq("id", documentId);

      // Chain next step via QStash (guaranteed delivery with retries)
      const baseUrl = new URL(req.url).origin;
      await enqueueChunk(documentId, baseUrl);

      return NextResponse.json({ step: nextStep, totalPages, completedPages: chunk0Pages, continue: true });
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
      const chunkSplit = await splitPDF(buffer, CHUNK_SIZE);
      // S320 — unreachable by construction: INIT single-chunks a degraded
      // split (totalChunks=1 → nextStep=classifying), so a chunk-continuation
      // request for one means state drifted. Terminate honestly, never wedge.
      if (chunkSplit.degraded) {
        await supabase.from("documents").update({
          status: "error",
          processing_error: "We couldn't finish reading this document. Please try uploading it again.",
          processing_step: null,
        }).eq("id", documentId);
        return NextResponse.json({ error: "Degraded split reached chunk continuation" }, { status: 500 });
      }
      const chunks = chunkSplit.chunks;

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
      const { applyHaikuFallback, applyBillParserSanityGate } = await import("@/lib/classifier/fallback");
      const rawClassification = await classifyWithHaiku(fullOcrText, doc.file_name, doc.doc_type);
      const fallbackResult = await applyHaikuFallback({
        supabase,
        classification: rawClassification,
        ocrText: fullOcrText,
        fileName: doc.file_name,
        userType: doc.doc_type,
      });
      const classification = fallbackResult.classification;
      const fallbackConfig = fallbackResult.config;

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

      console.log(`[process-chunk] Type resolution: user="${userType}" haiku="${haikuType}" confidence=${classification.confidence.toFixed(2)} → effective="${effectiveType}" skipCanonical=${skipCanonical} halt=${halt} fellBackToRegex=${fallbackResult.fellBackToRegex}`);

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
        const userForNotify = await getUserContextByPk(supabase, doc.user_id, "process-chunk:notifyAdminForReview");
        notifyAdminForReview(documentId, haikuType, classification.confidence, doc.file_name, userForNotify?.email || "unknown").catch(() => {});
        return NextResponse.json({ step: "pending_review", continue: false, error: "Low confidence — queued for admin review" });
      }

      // Medium confidence — notify admin if there's a type mismatch (canonical held)
      if (skipCanonical && typeMismatch) {
        const userForNotify = await getUserContextByPk(supabase, doc.user_id, "process-chunk:notifyAdminForReview");
        notifyAdminForReview(documentId, haikuType, classification.confidence, doc.file_name, userForNotify?.email || "unknown").catch(() => {});
      }

      // Route by document type: bills → audit pipeline, plan docs → extraction pipeline
      if (BILL_TYPES.has(effectiveType)) {
        // S94 B5 — sanity-gate the bill parser. Refuses on suspected SBCs even
        // when the resolver picked a bill type, catching the failure mode where
        // Haiku errored, regex agreed with the user's wrong pick, and the bill
        // parser would otherwise hallucinate CPT codes from page numbers.
        const { data: metaDoc } = await supabase
          .from("documents")
          .select("metadata")
          .eq("id", documentId)
          .maybeSingle();
        const inlinePageCount: number | null =
          metaDoc?.metadata?.classification_override?.page_count ?? null;
        const sanity = await applyBillParserSanityGate({
          config: fallbackConfig,
          effectiveType,
          ocrText: fullOcrText,
          pageCount: inlinePageCount,
        });
        if (sanity.blocked) {
          console.warn(`[process-chunk] Bill parser sanity gate blocked: ${sanity.reason}`);
          await supabase
            .from("documents")
            .update({
              status: "error",
              processing_step: "rejected_doc_type_mismatch",
              processing_error: sanity.reason,
              metadata: {
                ...(metaDoc?.metadata || {}),
                bill_parser_sanity_gate: {
                  blocked: true,
                  reason: sanity.reason,
                  matched_sbc_phrases: sanity.matchedSbcPhrases,
                  page_count: sanity.pageCount,
                  blocked_at: new Date().toISOString(),
                },
              },
            })
            .eq("id", documentId);
          return NextResponse.json({
            step: "rejected_doc_type_mismatch",
            continue: false,
            error: sanity.reason,
          });
        }
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
        baseUrl: new URL(req.url).origin,
      });

      console.log(`[process-chunk] Inline result: success=${result.success}, services=${result.servicesCreated}, skipCanonical=${skipCanonical}, resumeRequested=${result.resumeRequested === true}`);
      return NextResponse.json({ step: result.resumeRequested ? "eoc_resume_pending" : "done", continue: result.resumeRequested === true, ...result });
    }

    // ── STEP: CLASSIFYING + EXTRACTING + SAVING (all inline) ──────────────
    // With Vercel Pro (maxDuration=800), we can run classify → extract → save
    // in a single invocation. No more QStash handoffs for these stages.
    // For EOCs > 150 pages this may still hit the 800s ceiling — B14 work block
    // tracks the architectural fix (split classify/extract into sub-steps).
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
      const { applyHaikuFallback: applyHaikuFallbackFB, applyBillParserSanityGate: applyBillParserSanityGateFB } = await import("@/lib/classifier/fallback");
      const rawFbClassification = await classifyWithHaiku(ocrText, doc.file_name, doc.doc_type);
      const fbFallbackResult = await applyHaikuFallbackFB({
        supabase,
        classification: rawFbClassification,
        ocrText,
        fileName: doc.file_name,
        userType: doc.doc_type,
      });
      const classification = fbFallbackResult.classification;
      const fbFallbackConfig = fbFallbackResult.config;

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

      console.log(`[process-chunk] Type resolution: user="${fallbackUserType}" haiku="${fallbackHaikuType}" confidence=${classification.confidence.toFixed(2)} → effective="${fbEffectiveType}" skipCanonical=${fbSkipCanonical} halt=${fbHalt} fellBackToRegex=${fbFallbackResult.fellBackToRegex}`);

      // ID-Block (S173): re-save-invariant content fingerprint for corroboration
      // source-independence (a TRIGGER, never a reject). Scoped to the plan-doc
      // family — the only types that feed canonical promotion; bills/EOB/cards are
      // never fingerprinted. Inert until the id_block_corroboration gate reads it, so
      // this is byte-identical user-facing behavior. See
      // plans/id-block-corroboration-source-independence.md §3.1/§9.2.
      const fbIsPlanDocFamily =
        fbEffectiveType === "sbc" ||
        fbEffectiveType === "plan_document" ||
        fbEffectiveType === "eoc";
      const fbContentFingerprint = fbIsPlanDocFamily
        ? computeContentFingerprint(ocrText)
        : null;

      await supabase.from("documents").update({
        processing_step: "working_extracting",
        processing_started_at: new Date().toISOString(),
        classified_type: fbEffectiveType,
        classification_confidence: classification.confidence,
        type_mismatch: fallbackMismatch || false,
        content_fingerprint: fbContentFingerprint,
      }).eq("id", documentId);

      // Low confidence — halt
      if (fbHalt) {
        await supabase.from("documents").update({
          status: "pending_review",
          processing_error: "Low classification confidence. Queued for admin review.",
        }).eq("id", documentId);
        const userForNotify = await getUserContextByPk(supabase, doc.user_id, "process-chunk:notifyAdminForReview");
        notifyAdminForReview(documentId, fallbackHaikuType, classification.confidence, doc.file_name, userForNotify?.email || "unknown").catch(() => {});
        return NextResponse.json({ step: "pending_review", continue: false, error: "Low confidence — queued for admin review" });
      }

      // Medium confidence mismatch — notify admin
      if (fbSkipCanonical && fallbackMismatch) {
        const userForNotify = await getUserContextByPk(supabase, doc.user_id, "process-chunk:notifyAdminForReview");
        notifyAdminForReview(documentId, fallbackHaikuType, classification.confidence, doc.file_name, userForNotify?.email || "unknown").catch(() => {});
      }

      // Route by document type
      if (BILL_TYPES.has(fbEffectiveType)) {
        // S94 B5 — sanity-gate the bill parser (mirrors inline path above).
        const { data: fbMetaDoc } = await supabase
          .from("documents")
          .select("metadata")
          .eq("id", documentId)
          .maybeSingle();
        const fbPageCount: number | null =
          fbMetaDoc?.metadata?.classification_override?.page_count ?? null;
        const fbSanity = await applyBillParserSanityGateFB({
          config: fbFallbackConfig,
          effectiveType: fbEffectiveType,
          ocrText,
          pageCount: fbPageCount,
        });
        if (fbSanity.blocked) {
          console.warn(`[process-chunk] Bill parser sanity gate blocked: ${fbSanity.reason}`);
          await supabase
            .from("documents")
            .update({
              status: "error",
              processing_step: "rejected_doc_type_mismatch",
              processing_error: fbSanity.reason,
              metadata: {
                ...(fbMetaDoc?.metadata || {}),
                bill_parser_sanity_gate: {
                  blocked: true,
                  reason: fbSanity.reason,
                  matched_sbc_phrases: fbSanity.matchedSbcPhrases,
                  page_count: fbSanity.pageCount,
                  blocked_at: new Date().toISOString(),
                },
              },
            })
            .eq("id", documentId);
          return NextResponse.json({
            step: "rejected_doc_type_mismatch",
            continue: false,
            error: fbSanity.reason,
          });
        }
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
        baseUrl: new URL(req.url).origin,
      });

      console.log(`[process-chunk] Fallback result: success=${fbResult.success}, services=${fbResult.servicesCreated}, skipCanonical=${fbSkipCanonical}, resumeRequested=${fbResult.resumeRequested === true}`);
      return NextResponse.json({ step: fbResult.resumeRequested ? "eoc_resume_pending" : "done", continue: fbResult.resumeRequested === true, ...fbResult });
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
    // S320 — terminate, don't strand: write the error state so the user sees
    // an honest failure instead of an eternal spinner, and the retry stack
    // (built for transient failures) stops re-running a deterministic crash.
    // Best-effort: if even this write fails, the stale-recovery layers remain.
    if (documentIdForFailure) {
      try {
        const supabase = createServerClient();
        await supabase
          .from("documents")
          .update({
            status: "error",
            processing_error:
              "We couldn't finish reading this document. Please try uploading it again — support has been notified.",
            processing_step: null,
          })
          .eq("id", documentIdForFailure)
          .in("status", ["queued", "processing"]);
        notifyAdminForReview(
          documentIdForFailure,
          "processing_crash",
          0,
          error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
          "process-chunk",
        ).catch(() => {});
      } catch (writeErr) {
        console.error("[process-chunk] failure-state write failed:", writeErr);
      }
    }
    return NextResponse.json({ error: "Processing chunk failed" }, { status: 500 });
  }
}
