import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { extractFromSBC } from "@/lib/pipeline/benefit-extractor";

async function verifyAdmin(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data } = await supabase
      .from("users")
      .select("is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    return data?.is_admin === true;
  } catch {
    return false;
  }
}

/**
 * POST /api/admin/pipeline/extract
 * Body: { documentId } — triggers SBC extraction on an uploaded document
 * Or: { insurerId } — triggers extraction from insurer's public SBC URL
 */
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const { documentId, insurerId } = await req.json();
  const supabase = createServerClient();

  try {
    let fileBuffer: Buffer;
    let mimeType: string;
    let insurerName = "";
    let sourceType: "user_submitted" | "sbc" = "user_submitted";

    if (documentId) {
      // Extract from user-uploaded document
      const { data: doc } = await supabase
        .from("documents")
        .select("storage_path, file_name, user_id")
        .eq("id", documentId)
        .single();

      if (!doc) {
        return NextResponse.json({ error: "Document not found" }, { status: 404 });
      }

      const { data: fileData } = await supabase.storage
        .from("documents")
        .download(doc.storage_path);

      if (!fileData) {
        return NextResponse.json({ error: "Failed to download document" }, { status: 500 });
      }

      fileBuffer = Buffer.from(await fileData.arrayBuffer());
      mimeType = doc.file_name.endsWith(".pdf") ? "application/pdf" : "image/jpeg";
      sourceType = "user_submitted";

      // Try to get insurer name from user's profile
      const { data: profile } = await supabase
        .from("profiles")
        .select("insurer")
        .eq("user_id", doc.user_id)
        .single();
      insurerName = profile?.insurer || "";
    } else if (insurerId) {
      // Future: Download from insurer's SBC URL
      // For now, return a placeholder
      return NextResponse.json({
        error: "Automated SBC scraping not yet implemented. Upload a user-submitted SBC document instead.",
      }, { status: 501 });
    } else {
      return NextResponse.json({ error: "documentId or insurerId required" }, { status: 400 });
    }

    // Run extraction
    const extracted = await extractFromSBC(fileBuffer, mimeType);

    // Match or create insurer catalog entry
    let matchedInsurerId: string | null = null;
    if (insurerName || extracted.insurer) {
      const name = insurerName || extracted.insurer || "";
      const { data: insurer } = await supabase
        .from("insurer_catalog")
        .select("id")
        .ilike("name", `%${name}%`)
        .limit(1)
        .single();
      matchedInsurerId = insurer?.id || null;
    }

    // Store in plan_catalog
    const { data: plan, error: planError } = await supabase
      .from("plan_catalog")
      .insert({
        insurer_id: matchedInsurerId,
        plan_name: extracted.planName || "Unknown Plan",
        plan_type: extracted.planType,
        year: extracted.year,
        source_type: sourceType,
        source_document_id: documentId || null,
        raw_data: {
          deductibleIndividual: extracted.deductibleIndividual,
          deductibleFamily: extracted.deductibleFamily,
          oopMaxIndividual: extracted.oopMaxIndividual,
          oopMaxFamily: extracted.oopMaxFamily,
          confidence: extracted.confidence,
        },
        data_status: "extracted",
      })
      .select("id")
      .single();

    if (planError || !plan) {
      console.error("Failed to create plan catalog entry:", planError);
      return NextResponse.json({ error: "Failed to save plan data" }, { status: 500 });
    }

    // Store extracted benefits
    if (extracted.benefits.length > 0) {
      const benefitRows = extracted.benefits.map((b) => ({
        plan_id: plan.id,
        benefit_category: b.category,
        title: b.title,
        description: b.description,
        coverage_details: b.coverageDetails,
        copay_amount: b.copayAmount,
        coinsurance_pct: b.coinsurancePct,
        frequency_limit: b.frequencyLimit,
        prior_auth_required: b.priorAuthRequired,
        hsa_fsa_eligible: b.hsaFsaEligible,
        plan_document_reference: b.sourceReference,
        data_status: "extracted",
      }));

      await supabase.from("plan_benefits").insert(benefitRows);
    }

    // Update document status
    if (documentId) {
      await supabase
        .from("documents")
        .update({ status: "processed" })
        .eq("id", documentId);
    }

    return NextResponse.json({
      planId: plan.id,
      planName: extracted.planName,
      benefitsExtracted: extracted.benefits.length,
      confidence: extracted.confidence,
      deductible: extracted.deductibleIndividual,
      oopMax: extracted.oopMaxIndividual,
    });
  } catch (err) {
    console.error("Pipeline extraction error:", err);
    return NextResponse.json({ error: "Extraction failed" }, { status: 500 });
  }
}
