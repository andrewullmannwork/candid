import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { scrapeSBC } from "@/lib/pipeline/sbc-scraper";
import { extractFromSBC } from "@/lib/pipeline/benefit-extractor";

/**
 * POST /api/admin/pipeline/scrape
 * Body: { insurerId } — scrapes SBC for an insurer, extracts benefits, stores results
 * Full pipeline: scrape → OCR → extract → store in plan_catalog + plan_benefits
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { insurerId } = await req.json();
  if (!insurerId) {
    return NextResponse.json({ error: "insurerId required" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Get insurer details
  const { data: insurer } = await supabase
    .from("insurer_catalog")
    .select("*")
    .eq("id", insurerId)
    .single();

  if (!insurer) {
    return NextResponse.json({ error: "Insurer not found" }, { status: 404 });
  }

  // Update status to scraping
  await supabase
    .from("insurer_catalog")
    .update({ data_status: "scraping" })
    .eq("id", insurerId);

  try {
    // Step 1: Scrape SBC document
    const scrapeResult = await scrapeSBC(
      insurer.name,
      insurer.sbc_search_url
    );

    if (!scrapeResult.success || !scrapeResult.pdfBuffer) {
      await supabase
        .from("insurer_catalog")
        .update({ data_status: "failed", last_scraped_at: new Date().toISOString() })
        .eq("id", insurerId);

      return NextResponse.json({
        success: false,
        error: scrapeResult.error || "Could not find SBC document",
        method: scrapeResult.method,
        suggestion: "Upload an SBC document manually for this insurer.",
      });
    }

    // Step 2: Extract benefits from the PDF
    const extracted = await extractFromSBC(scrapeResult.pdfBuffer, scrapeResult.mimeType);

    // Step 3: Store in plan_catalog
    const { data: plan, error: planError } = await supabase
      .from("plan_catalog")
      .insert({
        insurer_id: insurerId,
        plan_name: extracted.planName || `${insurer.name} Plan`,
        plan_type: extracted.planType,
        year: extracted.year,
        source_url: scrapeResult.sourceUrl,
        source_type: "sbc",
        raw_data: {
          deductibleIndividual: extracted.deductibleIndividual,
          deductibleFamily: extracted.deductibleFamily,
          oopMaxIndividual: extracted.oopMaxIndividual,
          oopMaxFamily: extracted.oopMaxFamily,
          confidence: extracted.confidence,
          scrapeMethod: scrapeResult.method,
        },
        data_status: "extracted",
      })
      .select("id")
      .single();

    if (planError || !plan) {
      await supabase
        .from("insurer_catalog")
        .update({ data_status: "failed" })
        .eq("id", insurerId);
      return NextResponse.json({ error: "Failed to save plan data" }, { status: 500 });
    }

    // Step 4: Store extracted benefits
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

    // Step 5: Update insurer status
    await supabase
      .from("insurer_catalog")
      .update({
        data_status: "extracted",
        last_scraped_at: new Date().toISOString(),
      })
      .eq("id", insurerId);

    return NextResponse.json({
      success: true,
      planId: plan.id,
      planName: extracted.planName,
      benefitsExtracted: extracted.benefits.length,
      confidence: extracted.confidence,
      sourceUrl: scrapeResult.sourceUrl,
      method: scrapeResult.method,
    });
  } catch (err) {
    console.error("Pipeline scrape error:", err);
    await supabase
      .from("insurer_catalog")
      .update({ data_status: "failed" })
      .eq("id", insurerId);

    return NextResponse.json({
      error: err instanceof Error ? err.message : "Scrape failed",
    }, { status: 500 });
  }
}
