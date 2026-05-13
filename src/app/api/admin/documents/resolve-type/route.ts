/**
 * POST /api/admin/documents/resolve-type
 *
 * Admin endpoint to resolve document type for medium/low confidence documents.
 * Supports bulk operations: approve (use Haiku type), reject (use user type),
 * or reclassify (admin picks type). Triggers the correct processing pipeline
 * with canonical writes enabled.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  // Admin auth check
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data: adminUser } = await supabase
      .from("users")
      .select("is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (!adminUser?.is_admin) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const supabase = createServerClient();
  const { documentIds, resolvedType, action } = await req.json() as {
    documentIds: string[];
    resolvedType?: string;
    action: "approve" | "reject" | "reclassify";
  };

  if (!documentIds?.length || !action) {
    return NextResponse.json({ error: "documentIds and action are required" }, { status: 400 });
  }

  const validTypes = ["eob", "itemized_bill", "sbc", "plan_document"];
  if (action === "reclassify" && (!resolvedType || !validTypes.includes(resolvedType))) {
    return NextResponse.json({ error: "resolvedType must be one of: " + validTypes.join(", ") }, { status: 400 });
  }

  const results: Array<{ documentId: string; success: boolean; error?: string }> = [];

  for (const documentId of documentIds) {
    try {
      const { data: doc } = await supabase
        .from("documents")
        .select("id, user_id, file_name, doc_type, classified_type, processing_ocr_text, status")
        .eq("id", documentId)
        .single();

      if (!doc) {
        results.push({ documentId, success: false, error: "Document not found" });
        continue;
      }

      // Determine the type to process with
      let processType: string;
      switch (action) {
        case "approve":
          processType = doc.classified_type || doc.doc_type;
          break;
        case "reject":
          processType = doc.doc_type;
          break;
        case "reclassify":
          processType = resolvedType!;
          break;
      }

      // Update document with resolved type
      await supabase.from("documents").update({
        classified_type: processType,
        status: "queued",
        processing_error: null,
      }).eq("id", documentId);

      // If we have OCR text, trigger inline processing
      if (doc.processing_ocr_text) {
        const BILL_TYPES = new Set(["eob", "itemized_bill"]);

        if (BILL_TYPES.has(processType)) {
          // Bill pipeline
          const { parseBillWithHaiku } = await import("@/lib/billing/haiku-bill-parser");
          const { parseBillFromOCR } = await import("@/lib/billing/parser");
          const { runAudit } = await import("@/lib/audit");
          const { collectPricingData } = await import("@/lib/care/collector");

          const haikuParsed = await parseBillWithHaiku(doc.processing_ocr_text, documentId, doc.user_id, processType as "eob" | "itemized_bill");
          const parsedBill = haikuParsed || parseBillFromOCR(
            { text: doc.processing_ocr_text, pages: [], confidence: 0.8 },
            documentId,
            doc.user_id,
            processType as "eob" | "itemized_bill",
          );

          // F-2 — resolve plan + load coverage BEFORE runAudit so first-pass
          // findings reflect should_owe per plan instead of contractual writeoff.
          const { isFeatureEnabled } = await import("@/lib/config/product-flags");
          const { data: userForFlag } = await supabase.from("users").select("email").eq("firebase_uid", doc.user_id).single();
          const { resolveClaimPlanContext } = await import("@/lib/claims/plan-year-resolver");
          const { loadCoverageMapForPlan } = await import("@/lib/audit/coverage-loader");
          const { data: profile } = await supabase.from("profiles").select("active_insurance_plan_id").eq("user_id", doc.user_id).single();
          const { planId, planYear } = await resolveClaimPlanContext(supabase, {
            userId: doc.user_id,
            dateOfService: parsedBill.serviceDate || null,
            fallbackActivePlanId: profile?.active_insurance_plan_id || null,
          });
          const planCoverage = await loadCoverageMapForPlan(supabase, planId);

          const auditReport = await runAudit(parsedBill, planCoverage);

          // Persist claims
          try {
            if (await isFeatureEnabled("claims_persistence", userForFlag?.email || undefined)) {
              const { persistAuditResults } = await import("@/lib/claims/persist");
              await persistAuditResults(supabase, {
                userId: doc.user_id,
                insurancePlanId: planId || undefined,
                planYear,
                documentId,
                parsedBill,
                auditReport,
              });
            }
          } catch { /* non-fatal */ }

          try {
            const { data: profile } = await supabase.from("profiles").select("state").eq("user_id", doc.user_id).single();
            await collectPricingData(parsedBill, profile?.state || null);
          } catch { /* best-effort */ }

          await supabase.from("documents").update({ status: "processed" }).eq("id", documentId);
        } else {
          // Plan pipeline — admin confirmed, so skipCanonical=false
          const { processPlanDocumentData } = await import("@/lib/plan/process-plan");
          await processPlanDocumentData(
            supabase,
            { id: doc.id, user_id: doc.user_id, file_name: doc.file_name },
            doc.processing_ocr_text,
            documentId,
            { classifiedType: processType, confidence: 1.0, mismatch: false },
            { skipCanonical: false }
          );
        }

        results.push({ documentId, success: true });
      } else {
        // No OCR text — re-enqueue for full processing
        const { enqueueChunk } = await import("@/lib/queue/qstash");
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://candidclaim.com";
        await enqueueChunk(documentId, baseUrl);
        results.push({ documentId, success: true });
      }
    } catch (err) {
      console.error(`[resolve-type] Failed for ${documentId}:`, err);
      results.push({ documentId, success: false, error: err instanceof Error ? err.message : "Unknown error" });
    }
  }

  return NextResponse.json({ results });
}
