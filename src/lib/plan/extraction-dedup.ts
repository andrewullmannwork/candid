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
import { parsePlanDocument } from "@/lib/plan/plan-doc-parser";
import type { ProcessPlanResult } from "@/lib/plan/process-plan";
import { extractImportantQuestions } from "@/lib/sbc/haiku-prompts/important-questions";
import { verifySBCSourceExcerpts } from "@/lib/sbc/verify-source-excerpts";
import {
  buildSBCPlanIdentityProvenance,
  buildCanonicalInheritedProvenance,
} from "@/lib/parser/provenance-builders";
import type { FieldProvenanceEntry } from "@/lib/parser/field-categories";
import type { SBCPlanIdentity } from "@/lib/sbc/types";

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
    // Parse plan metadata from OCR preview (deductibles, OOP, etc.).
    // Phase 3.2.1: legacy parseSBCText removed; parsePlanDocument handles both SBC
    // and full-plan-document text via regex on shared field shapes.
    const parseResult = parsePlanDocument(ocrText);

    // CF-19a + CF-19c (Session 64) — HYBRID HAIKU FOR PLAN-IDENTITY:
    // Smart-skip used to copy canonical → user without running Haiku on the user's
    // actual document. That left field_provenance empty + lost the chance to extract
    // OON deductibles/OOP that canonical lacks columns for. Now: dispatch Haiku on
    // the SBC's "Important Questions" section ONLY (~$0.01-0.02; tiny vs full SBC
    // ~$0.04-0.10). Cost-sharing service rows still inherit from canonical.
    //
    // Result: plan-identity scalars (deductible/OOP both networks + plan_name +
    // plan_year + plan_type) get cite-grade Pattern P-8 path → "Document Verified"
    // when verifier confirms verbatim; "Found in Document" when verbatim_absent.
    // Replaces the regex output for these fields (parsePlanDocument's output is used
    // only for fields Haiku couldn't extract).
    let importantQuestionsHaiku: SBCPlanIdentity | null = null;
    let importantQuestionsCostUsd = 0;
    try {
      const iqResult = await extractImportantQuestions(
        ocrText,
        { start: 0, end: ocrText.length },
        "pdftotext",
      );
      // Run Pattern P-8 verifier on emitted excerpts. We construct a minimal
      // SBCHaikuParseResult shell — only planIdentity is populated since this is
      // the partial-Haiku smart-skip path.
      const verified = verifySBCSourceExcerpts(
        ocrText,
        {
          planIdentity: iqResult.data,
          services: [],
          excludedServices: [],
          excludedServicesPatternP8: null,
          otherCoveredServices: [],
          appealsContacts: [],
          parseWarnings: [],
          haikuTokensInput: iqResult.haiku_input_tokens,
          haikuTokensOutput: iqResult.haiku_output_tokens,
          haikuCacheCreateTokens: 0,
          haikuCacheReadTokens: 0,
          costUsd: iqResult.haiku_cost_usd,
          parseStrategyV2: true,
          dispatchedSections: ["important_questions"],
        },
        { important_questions: [{ start: 0, end: ocrText.length }] },
      );
      importantQuestionsHaiku = verified.planIdentity;
      importantQuestionsCostUsd = iqResult.haiku_cost_usd;
      console.log(`[extraction-dedup] Hybrid Haiku Important Questions: $${importantQuestionsCostUsd.toFixed(4)}`);
    } catch (iqErr) {
      // Non-fatal — fall through to regex parsePlanDocument output
      console.warn("[extraction-dedup] Hybrid Haiku Important Questions failed (non-fatal):", iqErr);
    }

    // Build plan-identity provenance: prefer Haiku output (cite-grade Pattern P-8);
    // fall back to canonical_inherited synthesis when Haiku didn't run / didn't extract.
    const planIdentityProvenanceFromHaiku: Record<string, FieldProvenanceEntry> = importantQuestionsHaiku
      ? buildSBCPlanIdentityProvenance(importantQuestionsHaiku, "doc_extraction", ["important_questions"])
      : {};

    // Resolve plan-identity field values: Haiku-extracted wins; regex fallback; null.
    const haikuVal = <T,>(field: { value: T } | undefined): T | null =>
      field?.value !== undefined && field.value !== null ? field.value : (null as T | null);
    const planNameValue = haikuVal(importantQuestionsHaiku?.planName)
      ?? identifiers.planName
      ?? null;
    const planTypeValue = haikuVal(importantQuestionsHaiku?.planType)
      ?? identifiers.planType
      ?? null;
    const planYearValue = haikuVal(importantQuestionsHaiku?.planYear)
      ?? identifiers.planYear
      ?? null;
    const inDedIndividual = haikuVal(importantQuestionsHaiku?.deductibleIndividual)
      ?? parseResult.plan.in_deductible_individual
      ?? null;
    const inDedFamily = haikuVal(importantQuestionsHaiku?.deductibleFamily)
      ?? parseResult.plan.in_deductible_family
      ?? null;
    const inOopIndividual = haikuVal(importantQuestionsHaiku?.oopMaxIndividual)
      ?? parseResult.plan.in_oop_max_individual
      ?? null;
    const inOopFamily = haikuVal(importantQuestionsHaiku?.oopMaxFamily)
      ?? parseResult.plan.in_oop_max_family
      ?? null;
    const outDedIndividual = haikuVal(importantQuestionsHaiku?.outDeductibleIndividual);
    const outDedFamily = haikuVal(importantQuestionsHaiku?.outDeductibleFamily);
    const outOopIndividual = haikuVal(importantQuestionsHaiku?.outOopMaxIndividual);
    const outOopFamily = haikuVal(importantQuestionsHaiku?.outOopMaxFamily);

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

    // Resolve final values with canonical fallback for IN-network only
    // (canonical schema doesn't carry OON for these; OON comes from Haiku or stays null).
    const finalInDed = inDedIndividual ?? canonical.deductible_individual ?? null;
    const finalInOop = inOopIndividual ?? canonical.oop_max_individual ?? null;

    // Check for existing active plan to merge into
    const { data: existingPlan } = await supabase
      .from("insurance_plans")
      .select("id, field_provenance")
      .eq("user_id", doc.user_id)
      .eq("is_active", true)
      .single();

    // Build the canonical_inherited provenance for any plan-identity field WITHOUT
    // Haiku-extracted provenance. Pattern 1 #14 honored — written to user-scoped table
    // only as inheritance pointer; canonical untouched.
    const canonicalInheritedFallback = buildCanonicalInheritedProvenance(
      "insurance_plans",
      [
        // Only include fields where Haiku didn't already produce provenance
        ...(planIdentityProvenanceFromHaiku.plan_name ? [] : [["plan_name", planNameValue ?? canonical.plan_name] as [string, unknown]]),
        ...(planIdentityProvenanceFromHaiku.insurer_name ? [] : [["insurer_name", insurer?.name ?? identifiers.insurer] as [string, unknown]]),
        ...(planIdentityProvenanceFromHaiku.plan_type ? [] : [["plan_type", planTypeValue ?? canonical.plan_type] as [string, unknown]]),
        ...(planIdentityProvenanceFromHaiku.plan_year ? [] : [["plan_year", planYearValue] as [string, unknown]]),
        ...(planIdentityProvenanceFromHaiku.in_deductible_individual ? [] : [["in_deductible_individual", finalInDed] as [string, unknown]]),
        ...(planIdentityProvenanceFromHaiku.in_deductible_family ? [] : [["in_deductible_family", inDedFamily] as [string, unknown]]),
        ...(planIdentityProvenanceFromHaiku.in_oop_max_individual ? [] : [["in_oop_max_individual", finalInOop] as [string, unknown]]),
        ...(planIdentityProvenanceFromHaiku.in_oop_max_family ? [] : [["in_oop_max_family", inOopFamily] as [string, unknown]]),
        // OON: only canonical_inherited fallback is meaningful when Haiku didn't extract;
        // canonical doesn't carry OON values today (CF-19c forward-looking — mig 071 added cols
        // but legacy canonicals are unpopulated until promotion events fire post-corroboration).
        ...(planIdentityProvenanceFromHaiku.out_deductible_individual ? [] : outDedIndividual !== null ? [["out_deductible_individual", outDedIndividual] as [string, unknown]] : []),
        ...(planIdentityProvenanceFromHaiku.out_deductible_family ? [] : outDedFamily !== null ? [["out_deductible_family", outDedFamily] as [string, unknown]] : []),
        ...(planIdentityProvenanceFromHaiku.out_oop_max_individual ? [] : outOopIndividual !== null ? [["out_oop_max_individual", outOopIndividual] as [string, unknown]] : []),
        ...(planIdentityProvenanceFromHaiku.out_oop_max_family ? [] : outOopFamily !== null ? [["out_oop_max_family", outOopFamily] as [string, unknown]] : []),
      ],
    );

    // Merged plan-identity field_provenance: Haiku-extracted + canonical_inherited fallback.
    const mergedPlanFieldProvenance: Record<string, FieldProvenanceEntry> = {
      ...canonicalInheritedFallback,
      ...planIdentityProvenanceFromHaiku, // Haiku entries take precedence (cite-grade)
    };

    let targetPlanId: string;

    if (existingPlan) {
      // Merge into existing plan
      targetPlanId = existingPlan.id;
      // Preserve any existing field_provenance entries we're not overwriting
      const existingProv = (existingPlan.field_provenance as Record<string, FieldProvenanceEntry> | null) ?? {};
      const mergedProv = { ...existingProv, ...mergedPlanFieldProvenance };
      await supabase.from("insurance_plans").update({
        canonical_plan_id: canonicalPlanId,
        source_document_id: doc.id,
        verification_status: "document_verified",
        in_deductible_individual: finalInDed,
        in_deductible_family: inDedFamily,
        in_oop_max_individual: finalInOop,
        in_oop_max_family: inOopFamily,
        out_deductible_individual: outDedIndividual,
        out_deductible_family: outDedFamily,
        out_oop_max_individual: outOopIndividual,
        out_oop_max_family: outOopFamily,
        field_provenance: mergedProv,
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
          plan_name: planNameValue ?? canonical.plan_name,
          insurer_name: insurer?.name || identifiers.insurer,
          plan_type: planTypeValue ?? canonical.plan_type,
          plan_year: planYearValue ?? undefined,
          in_deductible_individual: finalInDed,
          in_deductible_family: inDedFamily,
          in_oop_max_individual: finalInOop,
          in_oop_max_family: inOopFamily,
          out_deductible_individual: outDedIndividual,
          out_deductible_family: outDedFamily,
          out_oop_max_individual: outOopIndividual,
          out_oop_max_family: outOopFamily,
          source: "sbc_upload",
          source_document_id: doc.id,
          is_active: true,
          canonical_plan_id: canonicalPlanId,
          verification_status: "document_verified",
          field_provenance: mergedPlanFieldProvenance,
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
    // CF-19a (Session 64): now also propagates field_provenance — preferring canonical's
    // existing field_provenance if populated (carries cite-grade entries from prior Haiku
    // runs that landed on canonical via promotion events), else synthesizes
    // canonical_inherited entries for populated columns.
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
        .map((s) => {
          // Build per-row field_provenance: prefer canonical's existing entries (which
          // may include cite-grade Pattern P-8 from past promotion events) over fresh
          // canonical_inherited synthesis.
          const canonicalProvenance = (s.field_provenance as Record<string, FieldProvenanceEntry> | null) ?? null;
          const provenance = canonicalProvenance && Object.keys(canonicalProvenance).length > 0
            ? canonicalProvenance
            : buildCanonicalInheritedProvenance("plan_covered_services", [
                ["in_copay", s.copay],
                ["in_coinsurance", s.coinsurance],
                ["in_deductible_applies", s.deductible_applies],
                ["covered", s.is_covered !== false],
                ["prior_auth_required", s.requires_prior_auth || false],
                ["annual_limit_value", s.annual_limit],
                // CF-19c: OON cost-sharing if canonical now carries them (mig 071)
                ["out_copay", s.out_copay],
                ["out_coinsurance", s.out_coinsurance],
                ["out_deductible_applies", s.out_deductible_applies],
              ]);

          return {
            insurance_plan_id: targetPlanId,
            service_id: slugToId.get(s.service_slug!)!,
            concept_id: s.concept_id || null,
            place_of_service: "any",
            in_copay: s.copay,
            in_coinsurance: s.coinsurance,
            in_deductible_applies: s.deductible_applies,
            // CF-19c: OON cost-sharing from canonical (mig 071 — null until populated by promotion events)
            out_copay: s.out_copay ?? null,
            out_coinsurance: s.out_coinsurance ?? null,
            out_deductible_applies: s.out_deductible_applies ?? null,
            covered: s.is_covered !== false,
            prior_auth_required: s.requires_prior_auth || false,
            annual_limit_value: s.annual_limit || null,
            confidence: s.confidence,
            source: "sbc_parsed" as const,
            field_provenance: provenance,
          };
        });

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
