/**
 * Smart Extraction Skip (Document Dedup)
 *
 * Determines whether a document upload can skip full Haiku extraction
 * by matching against existing canonical plans with stable extraction data.
 *
 * Decision flow:
 *   1. SHA256 file hash → exact duplicate check
 *   2. Plan identifier extraction (regex first, Haiku fallback)
 *   3. Canonical plan lookup (insurer + fuzzy plan name + year)
 *   4. Sampling policy (extraction_count >= 3 + stable → skip)
 *
 * Safety invariant: when uncertain, ALWAYS extract (costs money but never loses data).
 */

import { createHash } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { jsonrepair } from "jsonrepair";
import { matchInsurerCatalog } from "@/lib/plan/insurer-match";
import { parseSBCText } from "@/lib/plan/sbc-parser";
import { parsePlanDocument } from "@/lib/plan/plan-doc-parser";
import type { ProcessPlanResult } from "@/lib/plan/process-plan";

type SupabaseClient = ReturnType<typeof import("@/lib/supabase/server").createServerClient>;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PlanIdentifiers {
  insurer: string | null;
  planName: string | null;
  groupNumber: string | null;
  planYear: number | null;
  planType: string | null;
  state: string | null;
  source: "regex" | "haiku_fallback";
}

export interface DedupResult {
  skip: boolean;
  canonicalPlanId?: string;
  reason: string;
}

// ── 1. File Hash ───────────────────────────────────────────────────────────────

export function computeFileHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// ── 2. Plan Identifier Extraction (Regex) ──────────────────────────────────────

const INSURER_PATTERNS: [RegExp, string][] = [
  [/cigna/i, "Cigna"],
  [/united\s*health/i, "UnitedHealthcare"],
  [/anthem/i, "Anthem"],
  [/aetna/i, "Aetna"],
  [/humana/i, "Humana"],
  [/kaiser/i, "Kaiser Permanente"],
  [/blue\s*cross/i, "Blue Cross Blue Shield"],
  [/molina/i, "Molina Healthcare"],
  [/oscar/i, "Oscar Health"],
  [/centene|ambetter|wellcare/i, "Centene"],
  [/highmark/i, "Highmark"],
  [/carefirst/i, "CareFirst"],
  [/florida\s*blue/i, "Florida Blue"],
  [/horizon/i, "Horizon BCBS"],
];

export function extractPlanIdentifiers(ocrText: string): PlanIdentifiers {
  const result: PlanIdentifiers = {
    insurer: null,
    planName: null,
    groupNumber: null,
    planYear: null,
    planType: null,
    state: null,
    source: "regex",
  };

  if (!ocrText || ocrText.length < 50) return result;

  // Use first ~5000 chars for identifier extraction (covers first 2+ pages)
  const text = ocrText.slice(0, 5000);

  // Insurer name — keyword detection (same patterns as sbc-parser.ts)
  for (const [pattern, name] of INSURER_PATTERNS) {
    if (pattern.test(text)) {
      result.insurer = name;
      break;
    }
  }

  // Plan name — SBC structured header format
  const structuredHeader = text.match(
    /(?:Coverage Period|Coverage for)[^\n]*\n[^\n]*?:\s*(.+?)(?:\n|$)/im
  );
  if (structuredHeader) {
    result.planName = structuredHeader[1].trim();
  }
  // Also try "Employer: Plan Name" pattern
  if (!result.planName) {
    const employerPlan = text.match(
      /([A-Z][^\n:]{3,50}):\s+((?:Open Access|PPO|HMO|EPO|POS|HDHP|OAP)[^\n]*)/im
    );
    if (employerPlan) {
      result.planName = employerPlan[2].trim();
    }
  }

  // Coverage period → plan year
  const periodMatch = text.match(
    /coverage\s+period[:\s]*(\d{2})\/(\d{2})\/(\d{4})/i
  );
  if (periodMatch) {
    result.planYear = parseInt(periodMatch[3], 10);
  }

  // Group number
  const groupMatch = text.match(
    /(?:group\s+(?:number|#|no\.?))[:\s]*(\S+)/i
  );
  if (groupMatch) {
    result.groupNumber = groupMatch[1].trim();
  }

  // Plan type
  const typeMatch = text.match(
    /plan\s+type[:\s]*(HMO|PPO|EPO|POS|OAP|HDHP)/i
  );
  if (typeMatch) {
    result.planType = typeMatch[1].toUpperCase();
  }

  return result;
}

// ── 3. Plan Identifier Extraction (Haiku Fallback) ─────────────────────────────

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

export async function extractPlanIdentifiersWithHaiku(
  ocrText: string
): Promise<PlanIdentifiers> {
  const fallback: PlanIdentifiers = {
    insurer: null, planName: null, groupNumber: null,
    planYear: null, planType: null, state: null,
    source: "haiku_fallback",
  };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallback;

  // Send only first ~2K chars (page 1) to minimize cost
  const headerText = ocrText.slice(0, 2000);

  try {
    const client = new Anthropic({ apiKey, timeout: 15000, maxRetries: 1 });
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 200,
      messages: [{
        role: "user",
        content: `Extract the insurance plan identifiers from this document header. Return ONLY a JSON object with these fields (use null if not found):
{"insurer": "company name", "planName": "plan name", "groupNumber": "group #", "planYear": 2025, "planType": "HMO/PPO/etc", "state": "XX"}

Document text:
${headerText}`,
      }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
      parsed = JSON.parse(jsonrepair(cleaned)) as Record<string, unknown>;
    }

    return {
      insurer: (parsed.insurer as string) || null,
      planName: (parsed.planName as string) || null,
      groupNumber: (parsed.groupNumber as string) || null,
      planYear: typeof parsed.planYear === "number" ? parsed.planYear : null,
      planType: (parsed.planType as string) || null,
      state: (parsed.state as string) || null,
      source: "haiku_fallback",
    };
  } catch (err) {
    console.warn("[extraction-dedup] Haiku identifier fallback failed:", err);
    return fallback;
  }
}

// ── 4. Decision Function ───────────────────────────────────────────────────────

export async function shouldSkipExtraction(
  supabase: SupabaseClient,
  documentId: string,
  fileHash: string,
  identifiers: PlanIdentifiers,
  _userId: string
): Promise<DedupResult> {
  const NO_SKIP = (reason: string): DedupResult => ({ skip: false, reason });

  // Step 1: Exact file hash match
  if (fileHash) {
    const { data: hashMatches } = await supabase
      .from("documents")
      .select("id, linked_insurance_plan_id")
      .eq("file_hash", fileHash)
      .eq("status", "processed")
      .neq("id", documentId)
      .limit(1);

    if (hashMatches && hashMatches.length > 0 && hashMatches[0].linked_insurance_plan_id) {
      // Trace to canonical plan
      const { data: linkedPlan } = await supabase
        .from("insurance_plans")
        .select("canonical_plan_id")
        .eq("id", hashMatches[0].linked_insurance_plan_id)
        .single();

      if (linkedPlan?.canonical_plan_id) {
        const { data: canonical } = await supabase
          .from("canonical_plans")
          .select("id, extraction_count, extraction_stable")
          .eq("id", linkedPlan.canonical_plan_id)
          .single();

        if (canonical?.extraction_stable) {
          console.log(`[extraction-dedup] File hash match → canonical ${canonical.id} is stable. SKIP.`);
          return { skip: true, canonicalPlanId: canonical.id, reason: "exact_file_hash_stable" };
        }
        console.log(`[extraction-dedup] File hash match but canonical not stable (count=${canonical?.extraction_count}). EXTRACT.`);
        return NO_SKIP("file_hash_match_not_stable");
      }
    }
  }

  // Step 2: Need identifiers for semantic matching
  if (!identifiers.insurer || !identifiers.planName) {
    return NO_SKIP("identifiers_incomplete");
  }

  // Step 3: Match insurer → insurer_catalog → canonical_plans
  const insurerMatch = await matchInsurerCatalog(supabase, identifiers.insurer);
  if (!insurerMatch) {
    return NO_SKIP("insurer_not_in_catalog");
  }

  const planYear = identifiers.planYear || new Date().getFullYear();

  // Query canonical plans for this insurer + year
  const { data: candidates } = await supabase
    .from("canonical_plans")
    .select("id, plan_name, extraction_count, extraction_stable, plan_year")
    .eq("insurer_id", insurerMatch.id)
    .eq("plan_year", planYear);

  if (!candidates || candidates.length === 0) {
    return NO_SKIP("no_canonical_for_insurer_year");
  }

  // Fuzzy match plan name — normalize and check containment
  const normalize = (s: string) =>
    s.toLowerCase().replace(/\s*(insurance|company|inc|corp|health\s*plan)\s*/gi, "").trim();
  const targetName = normalize(identifiers.planName);

  const match = candidates.find((c) => {
    const candidateName = normalize(c.plan_name);
    return (
      candidateName === targetName ||
      candidateName.includes(targetName) ||
      targetName.includes(candidateName)
    );
  });

  if (!match) {
    return NO_SKIP("no_plan_name_match");
  }

  // Step 4: Sampling policy
  if (match.extraction_count < 3) {
    console.log(`[extraction-dedup] Canonical ${match.id} has ${match.extraction_count} extractions (< 3). EXTRACT.`);
    return NO_SKIP(`needs_more_extractions_${match.extraction_count}`);
  }

  if (!match.extraction_stable) {
    console.log(`[extraction-dedup] Canonical ${match.id} not stable despite ${match.extraction_count} extractions. EXTRACT.`);
    return NO_SKIP("canonical_not_stable");
  }

  // All checks passed — skip extraction
  console.log(`[extraction-dedup] Canonical ${match.id} is stable (${match.extraction_count} extractions). SKIP.`);
  return { skip: true, canonicalPlanId: match.id, reason: "canonical_stable" };
}

// ── 5. Link Document to Canonical (Skip Path) ─────────────────────────────────

export async function linkDocumentToCanonical(
  supabase: SupabaseClient,
  doc: { id: string; user_id: string; file_name: string },
  canonicalPlanId: string,
  ocrText: string,
  identifiers: PlanIdentifiers
): Promise<ProcessPlanResult> {
  try {
    // Parse plan metadata from OCR preview (deductibles, OOP, etc.)
    const parseResult = ocrText.length > 50000
      ? parsePlanDocument(ocrText)
      : parseSBCText(ocrText, doc.id);

    // Get canonical plan data
    const { data: canonical } = await supabase
      .from("canonical_plans")
      .select("id, plan_name, plan_type, state, deductible_individual, oop_max_individual, premium_monthly, insurer_id")
      .eq("id", canonicalPlanId)
      .single();

    if (!canonical) {
      return { success: false, error: "Canonical plan not found" };
    }

    // Get insurer name
    const { data: insurer } = await supabase
      .from("insurer_catalog")
      .select("name")
      .eq("id", canonical.insurer_id)
      .single();

    // Check for existing active plan to merge into
    const { data: existingPlan } = await supabase
      .from("insurance_plans")
      .select("id")
      .eq("user_id", doc.user_id)
      .eq("is_active", true)
      .single();

    let targetPlanId: string;

    if (existingPlan) {
      // Merge into existing plan
      targetPlanId = existingPlan.id;
      await supabase.from("insurance_plans").update({
        canonical_plan_id: canonicalPlanId,
        source_document_id: doc.id,
        verification_status: "document_verified",
        in_deductible_individual: parseResult.plan.in_deductible_individual ?? canonical.deductible_individual,
        in_oop_max_individual: parseResult.plan.in_oop_max_individual ?? canonical.oop_max_individual,
      }).eq("id", targetPlanId);
    } else {
      // Create new plan linked to canonical
      // Deactivate old plans
      await supabase.from("insurance_plans")
        .update({ is_active: false })
        .eq("user_id", doc.user_id)
        .eq("is_active", true);

      const { data: newPlan, error: planError } = await supabase
        .from("insurance_plans")
        .insert({
          user_id: doc.user_id,
          plan_name: identifiers.planName || canonical.plan_name,
          insurer_name: insurer?.name || identifiers.insurer,
          plan_type: identifiers.planType || canonical.plan_type,
          plan_year: identifiers.planYear || canonical.state ? undefined : undefined,
          in_deductible_individual: parseResult.plan.in_deductible_individual ?? canonical.deductible_individual,
          in_oop_max_individual: parseResult.plan.in_oop_max_individual ?? canonical.oop_max_individual,
          source: "sbc_upload",
          source_document_id: doc.id,
          is_active: true,
          canonical_plan_id: canonicalPlanId,
          verification_status: "document_verified",
        })
        .select("id")
        .single();

      if (planError || !newPlan) {
        console.error("[extraction-dedup] Plan insert failed:", planError);
        return { success: false, error: `Plan creation failed: ${planError?.message}` };
      }
      targetPlanId = newPlan.id;

      // Update profile
      const profileUpdate: Record<string, unknown> = { active_insurance_plan_id: targetPlanId };
      if (identifiers.insurer) profileUpdate.insurer = identifiers.insurer;
      if (identifiers.planName) profileUpdate.plan_name = identifiers.planName;
      await supabase.from("profiles").update(profileUpdate).eq("user_id", doc.user_id);
    }

    // Copy canonical_plan_services → plan_covered_services
    const { data: canonicalServices } = await supabase
      .from("canonical_plan_services")
      .select("*")
      .eq("canonical_plan_id", canonicalPlanId);

    if (canonicalServices && canonicalServices.length > 0) {
      // Resolve service_slug → service_id
      const slugs = canonicalServices.map((s) => s.service_slug).filter(Boolean);
      const { data: serviceCatalog } = await supabase
        .from("service_catalog")
        .select("id, slug")
        .in("slug", slugs);

      const slugToId = new Map<string, string>();
      for (const svc of serviceCatalog || []) {
        slugToId.set(svc.slug, svc.id);
      }

      const serviceInserts = canonicalServices
        .filter((s) => s.service_slug && slugToId.has(s.service_slug))
        .map((s) => ({
          insurance_plan_id: targetPlanId,
          service_id: slugToId.get(s.service_slug!)!,
          concept_id: s.concept_id || null,
          place_of_service: "any",
          in_copay: s.copay,
          in_coinsurance: s.coinsurance,
          in_deductible_applies: s.deductible_applies,
          covered: s.is_covered !== false,
          prior_auth_required: s.requires_prior_auth || false,
          annual_limit_value: s.annual_limit || null,
          confidence: s.confidence,
          source: "sbc_parsed" as const,
        }));

      if (serviceInserts.length > 0) {
        const { error: svcError } = await supabase
          .from("plan_covered_services")
          .upsert(serviceInserts, { onConflict: "insurance_plan_id,service_id,place_of_service" });
        if (svcError) console.error("[extraction-dedup] Service copy failed:", svcError);
      }

      console.log(`[extraction-dedup] Copied ${serviceInserts.length} services from canonical to plan ${targetPlanId}`);
    }

    // Mark document as processed
    await supabase.from("documents").update({
      status: "processed",
      linked_insurance_plan_id: targetPlanId,
      processing_step: null,
    }).eq("id", doc.id);

    // Log the skip
    await supabase.from("document_extraction_log").insert({
      document_id: doc.id,
      user_id: doc.user_id,
      canonical_plan_id: canonicalPlanId,
      plan_identifiers: identifiers,
      action: "skipped_canonical_stable",
      services_extracted: canonicalServices?.length || 0,
      new_services_found: 0,
      skip_reason: "canonical_stable",
    });

    return {
      success: true,
      planId: targetPlanId,
      servicesCreated: canonicalServices?.length || 0,
      planData: {
        planName: identifiers.planName || canonical.plan_name,
        planType: identifiers.planType || canonical.plan_type,
        inDeductible: parseResult.plan.in_deductible_individual ?? canonical.deductible_individual,
        outDeductible: parseResult.plan.out_deductible_individual,
        inOopMax: parseResult.plan.in_oop_max_individual ?? canonical.oop_max_individual,
        outOopMax: parseResult.plan.out_oop_max_individual,
        servicesExtracted: canonicalServices?.length || 0,
      },
    };
  } catch (err) {
    console.error("[extraction-dedup] linkDocumentToCanonical error:", err);
    return { success: false, error: "Failed to link document to canonical plan" };
  }
}

// ── 6. Post-Extraction Tracking ────────────────────────────────────────────────

export async function recordExtractionResult(
  supabase: SupabaseClient,
  documentId: string,
  canonicalPlanId: string,
  userId: string,
  fileHash: string | null,
  extractedServiceSlugs: string[],
): Promise<void> {
  try {
    // Get existing canonical service slugs BEFORE this extraction merged
    const { data: existingServices } = await supabase
      .from("canonical_plan_services")
      .select("service_slug")
      .eq("canonical_plan_id", canonicalPlanId);

    const existingSlugs = new Set(
      (existingServices || []).map((s) => s.service_slug).filter(Boolean)
    );

    const newServicesFound = extractedServiceSlugs.filter(
      (slug) => !existingSlugs.has(slug)
    ).length;

    // Log this extraction
    await supabase.from("document_extraction_log").insert({
      document_id: documentId,
      user_id: userId,
      canonical_plan_id: canonicalPlanId,
      file_hash: fileHash,
      action: "full_extraction",
      services_extracted: extractedServiceSlugs.length,
      new_services_found: newServicesFound,
    });

    // Increment extraction count
    const { data: canonical } = await supabase
      .from("canonical_plans")
      .select("extraction_count")
      .eq("id", canonicalPlanId)
      .single();

    const newCount = (canonical?.extraction_count || 0) + 1;

    await supabase.from("canonical_plans").update({
      extraction_count: newCount,
      last_extraction_at: new Date().toISOString(),
    }).eq("id", canonicalPlanId);

    // Check stability: last 3 full extractions all found 0 new services
    if (newCount >= 3) {
      const { data: recentLogs } = await supabase
        .from("document_extraction_log")
        .select("new_services_found")
        .eq("canonical_plan_id", canonicalPlanId)
        .eq("action", "full_extraction")
        .order("created_at", { ascending: false })
        .limit(3);

      const allStable = recentLogs
        && recentLogs.length >= 3
        && recentLogs.every((l) => l.new_services_found === 0);

      if (allStable) {
        await supabase.from("canonical_plans")
          .update({ extraction_stable: true })
          .eq("id", canonicalPlanId);
        console.log(`[extraction-dedup] Canonical ${canonicalPlanId} marked stable after ${newCount} extractions`);
      }
    }
  } catch (err) {
    // Non-fatal — don't break the main pipeline
    console.error("[extraction-dedup] recordExtractionResult error (non-fatal):", err);
  }
}
