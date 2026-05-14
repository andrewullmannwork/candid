/**
 * Plan document processing — single-pass.
 * Runs classify → Haiku extract → DB save in one invocation.
 * Vercel Pro maxDuration=60 gives enough headroom for large documents.
 */

import { createServerClient } from "@/lib/supabase/server";
import { parsePlanDocumentWithMeta } from "@/lib/plan/plan-doc-parser";
import type { PlanDocHaikuParseResult } from "@/lib/plan_doc/types";
import {
  writeCanonicalHaikuExtractions,
  generateHaikuRunId,
  extractRowsFromSBCHaikuResult,
  extractRowsFromPlanDocHaikuResult,
} from "@/lib/parser/canonical-haiku-extractions";
import type { SBCPlanIdentity } from "@/lib/sbc/types";
import type { PlanDocPlanIdentity } from "@/lib/plan_doc/types";
import { extractServicesWithClaude } from "@/lib/plan/claude-extractor";
import { findOrCreateCanonicalPlan } from "@/lib/plan/canonical-match";
import { matchInsurerWithPlanFallback } from "@/lib/plan/insurer-match";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { votedParseSBC } from "@/lib/sbc/voted-parser";
import type { VotedParseSBCResult } from "@/lib/sbc/voted-parser";
import { translateHaikuToLegacy } from "@/lib/sbc/legacy-adapter";
import type { SBCHaikuService, SBCParseResult, SBCParsedService } from "@/lib/sbc/types";
import {
  buildPlanCoveredServiceProvenance,
  buildSBCPlanIdentityProvenance,
} from "@/lib/parser/provenance-builders";
import { loadValidServiceSlugs, enqueueUnknownServiceSlug } from "@/lib/parser/service-catalog-slugs";
import {
  commitUploadAndEvaluateCorroboration,
  PHASE_4_0_6_PLAN_IDENTITY_FIELDS_SBC,
  type FieldEvaluationCandidate,
} from "@/lib/parser/commit-and-evaluate";

type SupabaseClient = ReturnType<typeof createServerClient>;

export interface ProcessPlanResult {
  success: boolean;
  planId?: string;
  servicesCreated?: number;
  planData?: {
    planName?: string | null;
    planType?: string | null;
    inDeductible?: number | null;
    outDeductible?: number | null;
    inOopMax?: number | null;
    outOopMax?: number | null;
    servicesExtracted: number;
  };
  parseWarnings?: string[];
  error?: string;
  insurerMismatch?: { mismatch: boolean; type?: string; existingInsurer: string; parsedInsurer: string; existingPlanName?: string; parsedPlanName?: string } | null;
  yearRollover?: { currentYear: number; newYear: number } | null;
}

/**
 * Phase 4.0.6 — derive corroboration evaluation candidates from SBC parse
 * output. Plan-identity fields (service_slug=null) target canonical_plans;
 * per-service fields target canonical_plan_services per slug.
 *
 * Conservative v1 list — high-leverage cite-grade dispute fields (deductible,
 * OOP max, plan_year) + commonly-cited per-service cost-share fields (copay,
 * coinsurance). Phase 5+ may expand.
 *
 * Pattern P-8-eligible fields written via Pattern P-8 source_excerpt sub-keys
 * are correlated server-side (evaluator filters on source_excerpt_verified =
 * 'verified'); fields without verified excerpts return distinct_user_count=0
 * cheaply.
 */
function derivePromotionCandidatesFromHaikuResult(
  haikuResult: VotedParseSBCResult | null,
): FieldEvaluationCandidate[] {
  const candidates: FieldEvaluationCandidate[] = PHASE_4_0_6_PLAN_IDENTITY_FIELDS_SBC.map(
    (fieldName) => ({ serviceSlug: null, fieldName }),
  );

  if (!haikuResult) return candidates;

  const perServiceFields = [
    "copay",
    "coinsurance",
    "is_covered",
    "deductible_applies",
    "requires_prior_auth",
  ];
  const slugSet = new Set<string>();
  for (const s of [...haikuResult.services, ...haikuResult.otherCoveredServices]) {
    if (s.serviceSlug) slugSet.add(s.serviceSlug);
  }
  for (const slug of slugSet) {
    for (const fieldName of perServiceFields) {
      candidates.push({ serviceSlug: slug, fieldName });
    }
  }

  return candidates;
}

// ── S74.6 D1 — ACA-compliance column derivation ─────────────────────────────
//
// Both SBC Haiku-first (Important Questions) and plan_doc Haiku-first (plan_identity)
// extract `isAcaCompliant` + `acaComplianceBasis`. We derive the mig 093 columns:
//   - is_aca_compliant: boolean | null
//   - aca_compliance_basis: 'explicit_attestation' | 'inferred_marketplace' |
//                           'inferred_employer_post_2010' | 'explicit_grandfathered' |
//                           'unknown' | 'user_override' | 'admin_override'
//   - aca_compliance_source: 'sbc_parser' | 'plan_doc_parser' | '<parser>_default' |
//                            'user_override' | 'admin'
//   - aca_compliance_excerpt: Pattern P-8 verbatim ≤500 chars (best of basis/value field)
//
// Per Subplan §1 LOCK: when Haiku didn't extract a signal in any chunk
// (basis=null AND value=null), apply default `is_aca_compliant=TRUE` with
// `basis='unknown'` — conservative-for-users; most plans ARE ACA-compliant.
// User can override at plan-upload confirmation page (separate D1 UI surface).

type AcaIdentity = SBCPlanIdentity | PlanDocPlanIdentity | null | undefined;

interface AcaColumns {
  is_aca_compliant: boolean | null;
  aca_compliance_basis: string | null;
  aca_compliance_source: string | null;
  aca_compliance_excerpt: string | null;
}

const ACA_BASIS_ENUM = new Set([
  "explicit_attestation",
  "inferred_marketplace",
  "inferred_employer_post_2010",
  "explicit_grandfathered",
  "unknown",
]);

function pickAcaExcerpt(identity: NonNullable<AcaIdentity>): string {
  // Prefer the basis-field excerpt (richer context); fall back to the boolean
  // field excerpt. ≤500 chars per mig 093 column comment.
  const basisExcerpt = identity.acaComplianceBasis?.patternP8?.source_excerpt ?? "";
  const valueExcerpt = identity.isAcaCompliant?.patternP8?.source_excerpt ?? "";
  const chosen = basisExcerpt.length > 0 ? basisExcerpt : valueExcerpt;
  return chosen.slice(0, 500);
}

/**
 * Returns ACA columns extracted from Haiku output. When Haiku produced no signal
 * (both value and basis null), returns null — caller chooses whether to apply
 * default (new-plan insert) or skip the write (merge-update preserves prior).
 */
function extractedAcaColumns(
  identity: AcaIdentity,
  parserSourceLabel: string,
): AcaColumns | null {
  if (!identity) return null;
  const acaValue = identity.isAcaCompliant?.value ?? null;
  const rawBasis = identity.acaComplianceBasis?.value ?? null;
  if (acaValue === null && rawBasis === null) return null;
  // Defensive: clamp basis to enum; unknown strings collapse to 'unknown'.
  const basis =
    rawBasis && ACA_BASIS_ENUM.has(rawBasis) ? rawBasis : "unknown";
  return {
    is_aca_compliant: acaValue,
    aca_compliance_basis: basis,
    aca_compliance_source: parserSourceLabel,
    aca_compliance_excerpt: pickAcaExcerpt(identity),
  };
}

function defaultAcaColumns(parserSourceLabel: string): AcaColumns {
  return {
    is_aca_compliant: true,
    aca_compliance_basis: "unknown",
    aca_compliance_source: `${parserSourceLabel}_default`,
    aca_compliance_excerpt: "",
  };
}

function inferServiceCategory(slug: string): string {
  if (/rx|drug|pharm|medication|prescription/.test(slug)) return "rx";
  if (/mental|psych|behavioral|substance|counseling/.test(slug)) return "mental_health";
  if (/therapy|rehab|pt_|ot_|speech|habilitation/.test(slug)) return "therapy";
  if (/hospital|inpatient|surgical|surgery/.test(slug)) return "hospital";
  if (/emergency|er_|urgent/.test(slug)) return "emergency";
  if (/imaging|mri|ct_|xray|ultrasound|radiol/.test(slug)) return "imaging";
  if (/lab|test|blood|pathol/.test(slug)) return "lab";
  if (/maternity|prenatal|delivery|pregnancy|birth/.test(slug)) return "maternity";
  if (/prevent|screen|immuniz|vaccine|wellness|physical/.test(slug)) return "preventive";
  if (/dme|equipment|prosthetic|diabetic/.test(slug)) return "dme";
  if (/visit|office|pcp|specialist|physician/.test(slug)) return "office_visit";
  if (/dental|vision|eye|hearing|glasses/.test(slug)) return "other";
  if (/hospice|home_health|skilled_nursing/.test(slug)) return "other";
  return "other";
}

/**
 * Process a plan document (SBC or full plan certificate).
 * Single-pass: regex metadata → Haiku service extraction → DB writes.
 */
export async function processPlanDocumentData(
  supabase: SupabaseClient,
  doc: { id: string; user_id: string; file_name: string },
  ocrText: string,
  documentId: string,
  classification: { classifiedType: string; confidence: number; mismatch: boolean },
  options?: { skipCanonical?: boolean }
): Promise<ProcessPlanResult> {
  try {
    const isFullPlanDoc = classification.classifiedType === "plan_document"
      || (classification.classifiedType !== "sbc" && ocrText.length > 50000);

    // Mig 078 — read documents.purpose to know if this is a "primary" upload
    // (default: replaces user's active plan) or a "comparison" upload via
    // /compare (must NEVER overwrite primary; still feeds canonical
    // corroboration via Pattern 1 #14). NULL purpose (pre-mig-078 rows) is
    // treated as "primary" so behavior is unchanged for legacy data.
    const { data: docMeta } = await supabase
      .from("documents")
      .select("purpose")
      .eq("id", documentId)
      .single();
    const isComparisonUpload = docMeta?.purpose === "comparison";

    // ── Phase 3.2: Haiku-first SBC parser dispatch (behind sbc_parser_v1 flag) ─
    // Per Q-P3.2-2 LOCK = REPLACE: when flag ON + !isFullPlanDoc, use new
    // src/lib/sbc/ Haiku-first parser (Pattern P-8 + DR-3D + DR-3C voting).
    // Phase 3.2.1 Q-P3.2.1-1: legacy regex SBC parser dropped. Flag OFF on SBC route
    // throws explicit error (no silent fallback). plan_document classification still
    // uses regex parsePlanDocument + claude-extractor (F.14 fast-follow tracks Phase 3.4
    // migration to Haiku-first plan-doc parser).
    const { data: userForFlagCheck } = await supabase
      .from("users")
      .select("email, id")
      .eq("firebase_uid", doc.user_id)
      .single();
    const sbcParserV1Enabled = !isFullPlanDoc
      ? await isFeatureEnabled("sbc_parser_v1", userForFlagCheck?.email ?? undefined)
      : false;
    // Bundle PR #1 (Session 55, audit item #8) — Pattern 1 #1 admin gate context
    // for unknown slug routing. Threaded through votedParseSBC → parseSBC →
    // validateServiceSlugs. Unknowns hit service_catalog_admin_review_queue (mig 065)
    // for admin promotion to service_catalog. Without this context, validateServiceSlugs
    // falls back to drop-with-warning (e.g., parse-harness path).
    const slugEnqueueContext = {
      supabase,
      documentId,
      proposedByUserId: userForFlagCheck?.id ?? null,
    };

    let parseResult: SBCParseResult;
    let usedNewSBCParser = false;
    let haikuResult: VotedParseSBCResult | null = null;
    // S72 commit 4: captured rich Haiku result from plan_doc parser when flag ON.
    // Used post-canonical-resolution to write cite-grade citations to
    // canonical_haiku_extractions table.
    let planDocHaikuResult: PlanDocHaikuParseResult | null = null;
    let haikuFirstAppealsContact: ReturnType<typeof translateHaikuToLegacy>["appealsContact"] = null;

    if (sbcParserV1Enabled) {
      // SBC route under sbc_parser_v1 ON — Haiku-first parser is the only path.
      // Per Phase 3.2.1 Q-P3.2.1-1 LOCK: legacy regex fallback removed; Haiku-failure
      // throws explicit error → existing failed_extraction document state + Slack alert
      // + T0.4 retry surface. Pre-launch context permits this.
      console.log("[process-plan] sbc_parser_v1 ON — dispatching Haiku-first parser");
      try {
        haikuResult = await votedParseSBC({
          ocrText,
          extractionMethod: "pdftotext",
          canonicalMatchExists: false, // v1: always cold-start vote (N=3) for safety; v1.5 add canonical pre-check
          enqueueContext: slugEnqueueContext,
        });
      } catch (err) {
        console.error("[process-plan] sbc_parser_v1 failed:", err);
        throw new Error(`SBC_PARSE_FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
      const translated = translateHaikuToLegacy(haikuResult);
      parseResult = {
        plan: translated.plan,
        services: translated.services,
        confidence: translated.confidence,
        parseWarnings: translated.parseWarnings,
      };
      haikuFirstAppealsContact = translated.appealsContact;
      usedNewSBCParser = true;
      console.log(
        `[process-plan] sbc_parser_v1: ${haikuResult.services.length} services + ${haikuResult.otherCoveredServices.length} other-covered + voting=${haikuResult.votingMetadata.triggered ? `triggered (n=${haikuResult.votingMetadata.successfulAttempts}/${haikuResult.votingMetadata.n})` : "skipped"} + cost=$${haikuResult.costUsd.toFixed(4)}`,
      );
    } else if (isFullPlanDoc) {
      // plan_document classification → flag-gated dispatcher (S72 commit 3).
      // When `plan_doc_parser_v2` flag OFF (default), routes to legacy regex
      // parsePlanDocumentRegex (~49% recall) — same behavior as pre-S72.
      // When flag ON, routes to NEW Haiku-first parsePlanDocumentHaiku per Phase 3.1A
      // architectural template (~80%+ recall). Q-S72-2 (b) LOCK — EOC parser
      // plan-identity reuse at eoc/parser.ts also flips when flag flips.
      // F.14 fast-follow (claude-extractor.ts deletion) becomes possible once flag
      // is global ON for ~30 days post-S72 with no regressions.
      //
      // S72 commit 4: use parsePlanDocumentWithMeta to capture rich Haiku result
      // for canonical_haiku_extractions cite-grade citations write below
      // (post-canonical-resolution).
      const planDocResult = await parsePlanDocumentWithMeta(ocrText, {
        documentId: doc.id,
        extractionMethod: "pdftotext",
      });
      parseResult = planDocResult.legacy;
      planDocHaikuResult = planDocResult.haiku;
    } else {
      // SBC classification with sbc_parser_v1 OFF — explicit failure.
      // The flag stays in code as a kill-switch for debugging; flipping a specific
      // user OFF will surface this error rather than silently degrade their data.
      throw new Error("SBC_PARSER_DISABLED: sbc_parser_v1 flag is OFF for this user");
    }

    // ── Plan identity: Haiku primary, regex fallback (skipped under sbc_parser_v1) ────
    // Haiku reliably extracts plan name from any SBC format; regex is fragile.
    // The new SBC Haiku parser already extracts plan identity natively, so skip
    // this redundant call when usedNewSBCParser is true.
    if (!usedNewSBCParser) {
      try {
        const { extractPlanIdentifiersWithHaiku } = await import("@/lib/plan/extraction-dedup");
        const haikuIds = await extractPlanIdentifiersWithHaiku(ocrText);
        if (haikuIds.planName) {
          console.log("[process-plan] Haiku plan identity:", haikuIds.planName, "|", haikuIds.insurer, "|", haikuIds.planType);
          parseResult.plan.plan_name = haikuIds.planName;
        }
        // Haiku is also more reliable for insurer and plan type
        if (haikuIds.insurer) parseResult.plan.insurer_name = haikuIds.insurer;
        if (haikuIds.planType) parseResult.plan.plan_type = haikuIds.planType;
      } catch (haikuErr) {
        // Phase 3.2.1: this code path runs only for plan_document classification
        // (isFullPlanDoc=true). Haiku plan-identity augmentation is best-effort;
        // on failure, the regex parsePlanDocument result stands as-is.
        console.warn("[process-plan] Haiku plan identity failed, using regex fallback:", haikuErr);
      }
    }

    // ── Cross-check against profile plan name for canonical matching ────────
    // If user already has a plan name on profile (from card scan), it may be more
    // accurate for matching than the SBC-extracted name
    let profilePlanNameForCanonical: string | undefined;
    {
      const { data: profileCheck } = await supabase
        .from("profiles")
        .select("plan_name")
        .eq("user_id", doc.user_id)
        .single();

      if (profileCheck?.plan_name && profileCheck.plan_name !== parseResult.plan.plan_name) {
        profilePlanNameForCanonical = profileCheck.plan_name;
      }
    }

    // ── Haiku service extraction (skipped under sbc_parser_v1; new parser already extracted) ──
    if (usedNewSBCParser) {
      // New SBC Haiku parser already populated services + appealsContact;
      // skip the legacy claude-extractor call to avoid double-extraction.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parseResult as any).appealsContact = haikuFirstAppealsContact;
      console.log(`[process-plan] sbc_parser_v1: skipped legacy claude-extractor (Haiku-first produced ${parseResult.services.length} services)`);
    } else {
    console.log("[process-plan] Attempting Haiku extraction...");
    try {
      const claudeResult = await extractServicesWithClaude(
        ocrText,
        parseResult.plan.plan_name || null,
        isFullPlanDoc
      );

      // Phase 6.1 — pipe appealsContact to the self-updating insurer registry
      // regardless of service-extraction success; the doc may still contain a
      // valid appeals contact block even when services parsing failed. The
      // upsert runs after the insurer match resolves below (needs insurer_id).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parseResult as any).appealsContact = claudeResult.appealsContact ?? null;

      const haikuSucceeded =
        claudeResult.fromClaude && claudeResult.services.length > 0;

      if (haikuSucceeded) {
        // Bundle PR #1 (Session 55, audit item #8 plan_document slug-correctness
        // portion) — Pattern 1 #1 admin gate for claude-extractor output.
        // Validate against service_catalog (broader DB-truth vocab; not the
        // narrow STANDARD_SLUGS prompt list) → enqueue unknowns to admin queue.
        // Parser-quality angle (49% recall floor) stays in Phase 3.4 / F.14.
        const validSlugs = await loadValidServiceSlugs(supabase);
        const validatedServices: typeof claudeResult.services = [];
        let enqueuedCount = 0;
        for (const svc of claudeResult.services) {
          if (validSlugs.has(svc.serviceSlug)) {
            validatedServices.push(svc);
            continue;
          }
          try {
            await enqueueUnknownServiceSlug(supabase, {
              sourceDocId: documentId,
              proposedByUserId: slugEnqueueContext.proposedByUserId,
              parserSource: "plan_document",
              proposedServiceSlug: svc.serviceSlug,
              proposedServiceLabel: null,
              proposedCategory: null,
              // claude-extractor doesn't emit Pattern P-8 sub-keys — defaults reflect that.
              // Phase 3.4 Haiku-first migration will provide proper provenance.
              sourceExcerpt: "",
              sourceExcerptVerified: "not_found",
              sourceExcerptExtractionMethod: "pdftotext",
              sourceSectionHint: "plan_document",
              sourceSectionVerified: false,
              contextExtract: null,
            });
            enqueuedCount++;
          } catch (enqErr) {
            console.warn(`[process-plan] enqueue unknown slug failed: ${svc.serviceSlug}: ${enqErr instanceof Error ? enqErr.message : String(enqErr)}`);
          }
        }
        parseResult.services = validatedServices;
        console.log(`[process-plan] Haiku extracted ${claudeResult.services.length} services; ${validatedServices.length} validated against service_catalog; ${enqueuedCount} unknown slugs enqueued for admin`);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const extractorError = (claudeResult as any).error;
        const reason = `Haiku returned fromClaude=${claudeResult.fromClaude}, services=${claudeResult.services.length}${extractorError ? `, error: ${extractorError}` : ""}`;
        console.warn("[process-plan]", reason);
        await notifyAndFlagForReview(supabase, documentId, classification, doc, reason);
        return {
          success: true,
          servicesCreated: 0,
          planData: {
            planName: parseResult.plan.plan_name,
            planType: parseResult.plan.plan_type,
            inDeductible: parseResult.plan.in_deductible_individual,
            outDeductible: parseResult.plan.out_deductible_individual,
            inOopMax: parseResult.plan.in_oop_max_individual,
            outOopMax: parseResult.plan.out_oop_max_individual,
            servicesExtracted: 0,
          },
          parseWarnings: [...(parseResult.parseWarnings || []), "Service extraction requires admin review"],
        };
      }
    } catch (err) {
      const reason = `Haiku exception: ${err instanceof Error ? err.message : String(err)}`;
      console.error("[process-plan]", reason);
      await notifyAndFlagForReview(supabase, documentId, classification, doc, reason);
      return {
        success: true,
        servicesCreated: 0,
        parseWarnings: ["Service extraction failed — flagged for admin review"],
      };
    }
    } // end else (legacy claude-extractor path)

    // ── Plan insert + mismatch detection ────────────────────────────────────
    // Phase 3.2.1 Q-P3.2.1-2 + Q-P3.2.1-4: when haikuResult is available, persist
    // per-field Pattern P-8 provenance for plan-identity columns to insurance_plans.
    // field_provenance JSONB (mig 063). plan_document path leaves field_provenance
    // empty (default '{}') — plan-doc regex extraction has no patternP8.
    // Phase 4.0.5: pass haikuResult.dispatchedSections so each per-field
    // FieldProvenanceEntry records `searched_sections` — drives verbatim_absent
    // derivation + targeted re-parse coverage tracking. Forward-only per
    // Q-P4.0.5-7 LOCK (pre-Phase-4.0.5 rows have searched_sections=undefined).
    const planIdentityProvenance = haikuResult
      ? buildSBCPlanIdentityProvenance(haikuResult.planIdentity, "doc_extraction", haikuResult.dispatchedSections)
      : null;

    // S74.6 D1 — derive ACA-compliance columns from Haiku output (SBC or plan_doc).
    // Default-when-no-signal applied for new-plan insert; merge-update path below
    // skips the write when Haiku didn't extract (preserves prior value).
    const acaParserLabel = haikuResult
      ? "sbc_parser"
      : planDocHaikuResult
        ? "plan_doc_parser"
        : "regex_parser";
    const acaCandidate: AcaIdentity =
      haikuResult?.planIdentity ?? planDocHaikuResult?.planIdentity ?? null;
    const extractedAca = extractedAcaColumns(acaCandidate, acaParserLabel);
    const acaForInsert: AcaColumns = extractedAca ?? defaultAcaColumns(acaParserLabel);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const planInsert: Record<string, any> = {
      ...parseResult.plan,
      user_id: doc.user_id,
      source: (isFullPlanDoc ? "plan_doc_upload" : "sbc_upload") as string,
      source_document_id: documentId,
      // Comparison uploads start inactive — they live in insurance_plans (so
      // they feed canonical corroboration) but never become the user's
      // primary plan. is_active=true only for "primary" purpose uploads.
      is_active: !isComparisonUpload,
      verification_status: "document_verified" as const,
      ...(planIdentityProvenance ? { field_provenance: planIdentityProvenance } : {}),
      // S74.6 D1 — ACA-compliance columns (mig 093). Default fires for legacy
      // regex parses + Haiku-no-signal cases; explicit values fire when Haiku
      // extracted in any plan-identity chunk.
      ...acaForInsert,
    };

    const { data: userProfile } = await supabase
      .from("profiles")
      .select("deductible_individual, oop_max_individual, insurer, plan_name")
      .eq("user_id", doc.user_id)
      .single();

    if (userProfile) {
      planInsert.in_deductible_individual ??= userProfile.deductible_individual;
      planInsert.in_oop_max_individual ??= userProfile.oop_max_individual;
    }

    // Detect insurer or plan name mismatch
    const normalize = (s: string | null | undefined) =>
      (s || "").toLowerCase().replace(/\s*(insurance|company|inc|corp|health\s*plan)\s*/gi, "").trim();
    const profileInsurer = normalize(userProfile?.insurer);
    const parsedInsurer = normalize(planInsert.insurer_name);

    let mismatchData: {
      mismatch: boolean;
      type: "insurer" | "plan_name";
      existingInsurer: string;
      parsedInsurer: string;
      existingPlanName?: string;
      parsedPlanName?: string;
    } | null = null;

    if (profileInsurer && parsedInsurer
      && profileInsurer !== parsedInsurer
      && !profileInsurer.includes(parsedInsurer)
      && !parsedInsurer.includes(profileInsurer)) {
      mismatchData = {
        mismatch: true,
        type: "insurer",
        existingInsurer: userProfile?.insurer || "",
        parsedInsurer: planInsert.insurer_name || "",
      };
    } else if (userProfile?.plan_name && planInsert.plan_name
      && normalize(userProfile.plan_name) !== normalize(planInsert.plan_name)
      && !normalize(userProfile.plan_name).includes(normalize(planInsert.plan_name))
      && !normalize(planInsert.plan_name).includes(normalize(userProfile.plan_name))) {
      mismatchData = {
        mismatch: true,
        type: "plan_name",
        existingInsurer: userProfile?.insurer || "",
        parsedInsurer: planInsert.insurer_name || "",
        existingPlanName: userProfile.plan_name,
        parsedPlanName: planInsert.plan_name,
      };
    }

    // ── Plan year rollover detection ─────────────────────────────────────────
    let yearRollover: { currentYear: number; newYear: number } | null = null;
    if (!mismatchData && planInsert.plan_year) {
      const { data: existingActivePlanForYear } = await supabase
        .from("insurance_plans")
        .select("plan_year")
        .eq("user_id", doc.user_id)
        .eq("is_active", true)
        .single();

      if (existingActivePlanForYear?.plan_year
        && existingActivePlanForYear.plan_year !== planInsert.plan_year) {
        yearRollover = {
          currentYear: existingActivePlanForYear.plan_year,
          newYear: planInsert.plan_year,
        };
        console.log(`[process-plan] Year rollover: ${yearRollover.currentYear} → ${yearRollover.newYear}`);
      }
    }

    if (mismatchData) {
      console.log(`[process-plan] Mismatch (${mismatchData.type})`);
      await supabase.from("documents").update({ insurer_mismatch: mismatchData }).eq("id", documentId);
      planInsert.is_active = false;
    }

    if (yearRollover) {
      // Store year rollover info alongside any mismatch data
      await supabase.from("documents").update({
        insurer_mismatch: { ...(mismatchData || {}), year_rollover: yearRollover },
      }).eq("id", documentId);
      planInsert.is_active = false; // Wait for user confirmation before activating new year plan
    }

    // If no mismatch and an active plan exists, MERGE services into it
    // (SBC + plan document are complementary sources for the same plan).
    // Comparison uploads SKIP merging — they're a separate plan the user
    // wants to evaluate, not an enrichment of their primary.
    let mergeIntoExistingPlan: string | null = null;
    if (!mismatchData && !yearRollover && !isComparisonUpload) {
      const { data: existingActivePlan } = await supabase
        .from("insurance_plans")
        .select("id")
        .eq("user_id", doc.user_id)
        .eq("is_active", true)
        .single();
      if (existingActivePlan) {
        mergeIntoExistingPlan = existingActivePlan.id;
        console.log(`[process-plan] Merging into existing active plan: ${mergeIntoExistingPlan}`);
      }
    }

    // If merging, skip creating a new plan — use the existing one
    // If not merging (mismatch or no existing plan), create a new plan
    let targetPlanId: string;

    if (mergeIntoExistingPlan) {
      targetPlanId = mergeIntoExistingPlan;
      // Update the existing plan with any new metadata (deductibles, OOP, etc.)
      // Phase 3.2.1 — also propagate field_provenance from this upload's parse so
      // Pattern P-8 cite chain stays current. Plan_document path skips since
      // planIdentityProvenance is null there.
      await supabase.from("insurance_plans").update({
        source: (isFullPlanDoc ? "plan_doc_upload" : "sbc_upload") as string,
        source_document_id: documentId,
        is_active: true,
        verification_status: "document_verified" as const,
        in_deductible_individual: planInsert.in_deductible_individual,
        in_oop_max_individual: planInsert.in_oop_max_individual,
        out_deductible_individual: planInsert.out_deductible_individual,
        out_oop_max_individual: planInsert.out_oop_max_individual,
        ...(planIdentityProvenance ? { field_provenance: planIdentityProvenance } : {}),
        // S74.6 D1 — propagate ACA columns only when THIS parse extracted a
        // signal. When Haiku found nothing, preserve the plan's prior ACA value
        // (don't overwrite a previously-extracted basis with 'unknown' just
        // because this re-parse chunk lacked the phrase).
        ...(extractedAca ?? {}),
      }).eq("id", targetPlanId);
      // Ensure profile points to this plan and back-populate plan info
      const profileUpdate: Record<string, unknown> = { active_insurance_plan_id: targetPlanId };
      if (planInsert.insurer_name) profileUpdate.insurer = planInsert.insurer_name;
      if (planInsert.plan_name) profileUpdate.plan_name = planInsert.plan_name;
      await supabase.from("profiles").update(profileUpdate).eq("user_id", doc.user_id);
    } else {
      // For comparison uploads: never deactivate the user's existing primary
      // plan. The new comparison row inserts with is_active=false (per planInsert
      // above), so coexistence is automatic.
      if (!mismatchData && !isComparisonUpload) {
        // Deactivate old plans (but don't delete — data stays for platform)
        await supabase
          .from("insurance_plans")
          .update({ is_active: false })
          .eq("user_id", doc.user_id)
          .eq("is_active", true);
      }

      const { data: newPlan, error: planError } = await supabase
        .from("insurance_plans")
        .insert(planInsert)
        .select("id")
        .single();

      if (planError || !newPlan) {
        console.error("Failed to create insurance plan:", planError);
        await supabase.from("documents").update({ status: "error", processing_error: planError?.message || "Plan insert failed" }).eq("id", documentId);
        return { success: false, error: `Failed to save plan: ${planError?.message || "unknown"}`, parseWarnings: parseResult.parseWarnings };
      }

      targetPlanId = newPlan.id;

      // Comparison uploads must NOT touch the profile's active_insurance_plan_id —
      // the user's existing primary plan stays the active one.
      if (!mismatchData && !isComparisonUpload) {
        // Back-populate profile with plan info from document
        const profileUpdate: Record<string, unknown> = { active_insurance_plan_id: newPlan.id };
        if (planInsert.insurer_name) profileUpdate.insurer = planInsert.insurer_name;
        if (planInsert.plan_name) profileUpdate.plan_name = planInsert.plan_name;
        await supabase.from("profiles").update(profileUpdate).eq("user_id", doc.user_id);
      }
    } // end else (create new plan)

    // ── Canonical plan matching (feature-flagged) ─────────────────────────────
    // Skip canonical writes when skipCanonical is true (medium-confidence docs held for admin review)
    const skipCanonical = options?.skipCanonical === true;
    if (skipCanonical) {
      console.log("[process-plan] skipCanonical=true — skipping canonical plan matching and service upsert");
    }
    let canonicalPlanId: string | null = null;
    let canonicalNeedsConfirmation = false;
    let canonicalIsNew = false;

    // Check feature flag — get user email for targeting
    const { data: userForFlag } = await supabase.from("users").select("email").eq("firebase_uid", doc.user_id).single();
    const canonicalEnabled = await isFeatureEnabled("canonical_plans", userForFlag?.email || undefined);

    if (!canonicalEnabled) {
      console.log("[canonical-plan] Feature flag disabled for this user, skipping");
    } else if (skipCanonical) {
      // Medium-confidence doc — held for admin review, don't touch canonical tables
    } else try {
      // Use the plan-name fallback so PEO-administered plans (where
      // `insurer_name` was captured as the group sponsor — e.g., "Sequoia
      // One PEO, LLC") still resolve to their actual carrier (e.g., Cigna
      // via plan-name inference on "Open Access Plus"). Without this,
      // canonical_plan_id stays null for PEO plans → community/sibling/
      // pricing signals never populate. See OPS.4 in Candid_Todos.
      const insurerMatch = await matchInsurerWithPlanFallback(supabase, {
        insurerName: planInsert.insurer_name,
        planName: planInsert.plan_name,
      });
      if (insurerMatch?.via === "plan_name_inference") {
        console.log("[canonical-plan] insurer matched via plan-name inference", {
          insurerName: planInsert.insurer_name,
          planName: planInsert.plan_name,
          matchedInsurer: insurerMatch.name,
        });
      }

      // Phase 6.1 — feed Haiku-extracted appeals block into the self-updating registry.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const appealsContact = (parseResult as any).appealsContact ?? null;
      if (insurerMatch && appealsContact) {
        try {
          const { upsertAppealsFromDoc } = await import("@/lib/disputes/insurer-appeals-upsert");
          await upsertAppealsFromDoc(supabase, {
            insurerId: insurerMatch.id,
            extracted: {
              addressLine1: appealsContact.addressLine1,
              addressLine2: appealsContact.addressLine2,
              city: appealsContact.city,
              state: appealsContact.state,
              postalCode: appealsContact.postalCode,
              phone: appealsContact.phone,
              sourceExcerpt: appealsContact.sourceExcerpt,
              sourcePage: appealsContact.sourcePage,
              confidence: appealsContact.confidence,
            },
            userId: doc.user_id,
            documentId,
          });
        } catch (err) {
          console.error("[process-plan] appeals upsert failed (non-fatal):", err);
        }
      }
      if (insurerMatch && planInsert.plan_name) {
        // Get user profile for state, group_number, and hios_id from insurance_plans
        const { data: profileForCanonical } = await supabase
          .from("profiles")
          .select("state, group_number, active_insurance_plan_id")
          .eq("user_id", doc.user_id)
          .single();

        // Check for hios_id on the user's insurance_plan (from card scan → plan_catalog match)
        let hiosId: string | undefined;
        if (profileForCanonical?.active_insurance_plan_id) {
          const { data: userPlan } = await supabase
            .from("insurance_plans")
            .select("hios_id")
            .eq("id", profileForCanonical.active_insurance_plan_id)
            .single();
          hiosId = userPlan?.hios_id || undefined;
        }

        const canonicalResult = await findOrCreateCanonicalPlan(supabase, {
          insurerId: insurerMatch.id,
          planName: planInsert.plan_name,
          altPlanName: profilePlanNameForCanonical,
          planType: planInsert.plan_type || undefined,
          state: profileForCanonical?.state || undefined,
          planYear: planInsert.plan_year || new Date().getFullYear(),
          groupNumber: profileForCanonical?.group_number || undefined,
          hiosId,
          deductible: planInsert.in_deductible_individual || undefined,
          oopMax: planInsert.in_oop_max_individual || undefined,
        });

        if (canonicalResult.needsConfirmation) {
          // Store pending match for user confirmation — don't link yet
          canonicalNeedsConfirmation = true;
          await supabase.from("documents").update({
            insurer_mismatch: {
              ...(mismatchData || {}),
              pending_canonical_match: {
                canonicalPlanId: canonicalResult.canonicalPlanId,
                matchedPlanName: canonicalResult.matchedPlanName,
                confidence: canonicalResult.confidence,
                sourceCount: canonicalResult.sourceCount,
                insurerName: insurerMatch.name,
              },
            },
          }).eq("id", documentId);
          console.log(`[canonical-plan] Pending confirmation for canonical plan ${canonicalResult.canonicalPlanId} (confidence=${canonicalResult.confidence.toFixed(2)})`);
        } else {
          // Auto-link (high confidence or new plan)
          canonicalPlanId = canonicalResult.canonicalPlanId;
          canonicalIsNew = canonicalResult.isNew;
          await supabase.from("insurance_plans")
            .update({ canonical_plan_id: canonicalPlanId })
            .eq("id", targetPlanId);

          // Copy premium data from insurance_plans to canonical_plans if available
          if (planInsert.premium_total || planInsert.premium_employee) {
            const premiumMonthly = planInsert.premium_frequency === "monthly"
              ? (planInsert.premium_employee || planInsert.premium_total)
              : planInsert.premium_frequency === "biweekly"
                ? ((planInsert.premium_employee || planInsert.premium_total || 0) * 26 / 12)
                : null;

            if (premiumMonthly) {
              await supabase.from("canonical_plans")
                .update({ premium_monthly: premiumMonthly, updated_at: new Date().toISOString() })
                .eq("id", canonicalPlanId)
                .is("premium_monthly", null); // Only fill if not already set
            }
          }

          console.log(`[canonical-plan] Auto-linked insurance_plan=${targetPlanId} → canonical=${canonicalPlanId} (confidence=${canonicalResult.confidence.toFixed(2)}, new=${canonicalResult.isNew})`);
        }
      } else {
        console.log("[canonical-plan] Skipped — could not resolve insurer or missing plan name");
      }
    } catch (err) {
      console.error("[canonical-plan] Error during canonical matching (non-fatal):", err);
    }

    // ── Service catalog + plan_covered_services ─────────────────────────────
    let servicesCreated = 0;
    if (parseResult.services.length > 0) {
      const allSlugs = [...new Set(parseResult.services.map((s) => s.serviceSlug))];
      const BATCH_SIZE = 50;
      const slugToId = new Map<string, string>();

      for (let i = 0; i < allSlugs.length; i += BATCH_SIZE) {
        const batch = allSlugs.slice(i, i + BATCH_SIZE);
        const { data: existing } = await supabase.from("service_catalog").select("id, slug").in("slug", batch);
        for (const s of existing || []) slugToId.set(s.slug, s.id);
      }

      const newSlugs = allSlugs.filter((slug) => !slugToId.has(slug));
      if (newSlugs.length > 0) {
        const newEntries = newSlugs.map((slug) => ({
          slug,
          name: slug.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
          category: inferServiceCategory(slug),
          description: "",
          is_preventive_eligible: false,
        }));

        for (let i = 0; i < newEntries.length; i += BATCH_SIZE) {
          const batch = newEntries.slice(i, i + BATCH_SIZE);
          const { data: created } = await supabase.from("service_catalog").upsert(batch, { onConflict: "slug" }).select("id, slug");
          for (const entry of created || []) slugToId.set(entry.slug, entry.id);
        }

        // Create CANDID concepts
        const conceptInserts = newEntries.map((entry) => ({
          vocabulary_id: "CANDID", concept_code: entry.slug, concept_name: entry.name, concept_class: "service", domain: "service",
        }));
        for (let i = 0; i < conceptInserts.length; i += BATCH_SIZE) {
          await supabase.from("concepts").upsert(conceptInserts.slice(i, i + BATCH_SIZE), { onConflict: "vocabulary_id,concept_code" });
        }

        // Backfill concept_id
        const { data: newConcepts } = await supabase
          .from("concepts").select("id, concept_code")
          .eq("vocabulary_id", "CANDID").eq("concept_class", "service").in("concept_code", newSlugs);
        if (newConcepts) {
          for (const concept of newConcepts) {
            await supabase.from("service_catalog").update({ concept_id: concept.id }).eq("slug", concept.concept_code).is("concept_id", null);
          }
        }

        const otherSlugs = newEntries.filter(e => e.category === "other").map(e => e.slug);
        if (otherSlugs.length > 0) {
          try {
            const { notifyUncategorizedServices } = await import("@/lib/notifications");
            await notifyUncategorizedServices(otherSlugs);
          } catch { /* non-critical */ }
        }
      }

      // Build concept_id map
      const conceptIdMap = new Map<string, string>();
      for (let i = 0; i < allSlugs.length; i += BATCH_SIZE) {
        const batch = allSlugs.slice(i, i + BATCH_SIZE);
        const { data: svcWithConcepts } = await supabase.from("service_catalog").select("slug, concept_id").in("slug", batch);
        for (const svc of svcWithConcepts || []) {
          if (svc.concept_id) conceptIdMap.set(svc.slug, svc.concept_id);
        }
      }

      // Deduplicate: keep highest-confidence per (slug, place_of_service)
      const deduped = new Map<string, SBCParsedService>();
      for (const s of parseResult.services) {
        if (!slugToId.has(s.serviceSlug)) continue;
        const key = `${s.serviceSlug}|${s.placeOfService || "any"}`;
        const existing = deduped.get(key);
        if (!existing || s.confidence > existing.confidence) deduped.set(key, s);
      }

      const confident = [...deduped.values()].filter(s => s.confidence >= 0.5);

      // Phase 3.2.1 — when haikuResult is available, build a parallel map of
      // SBCHaikuService rows keyed by (slug, place_of_service) so we can attach
      // Pattern P-8 field_provenance JSONB to each persisted plan_covered_services
      // row. Plan_document path (haikuResult=null) skips field_provenance writes;
      // those rows default to '{}' per mig 056.
      const haikuServiceByKey = new Map<string, SBCHaikuService>();
      if (haikuResult) {
        for (const hs of [...haikuResult.services, ...haikuResult.otherCoveredServices]) {
          const key = `${hs.serviceSlug}|${hs.placeOfService || "any"}`;
          const existing = haikuServiceByKey.get(key);
          if (!existing || hs.confidence > existing.confidence) haikuServiceByKey.set(key, hs);
        }
      }

      const serviceInserts = confident.map((s) => {
        const haikuService = haikuServiceByKey.get(`${s.serviceSlug}|${s.placeOfService || "any"}`);
        return {
          insurance_plan_id: targetPlanId,
          service_id: slugToId.get(s.serviceSlug)!,
          concept_id: conceptIdMap.get(s.serviceSlug) || null,
          place_of_service: s.placeOfService || "any",
          in_copay: s.inCopay, in_coinsurance: s.inCoinsurance,
          in_deductible_applies: s.inDeductibleApplies, in_copay_waiver_condition: s.inCopayWaiverCondition,
          in_cost_description: s.inCostDescription,
          out_copay: s.outCopay, out_coinsurance: s.outCoinsurance,
          out_deductible_applies: s.outDeductibleApplies, out_cost_description: s.outCostDescription,
          oon_paid_at_in_network: s.oonPaidAtInNetwork,
          annual_limit: s.annualLimit, annual_limit_value: s.annualLimitValue,
          prior_auth_required: s.priorAuthRequired, penalty_no_precert: s.penaltyNoPrecert,
          covered: s.covered, coverage_conditions: s.coverageConditions,
          supply_limit_days: s.supplyLimitDays, home_delivery_copay: s.homeDeliveryCopay,
          step_therapy_required: s.stepTherapyRequired, notes: s.notes,
          confidence: s.confidence, source: "sbc_parsed" as const,
          // Phase 4.5 — SBC direct-quote citation support. `sbc_excerpt` +
          // `sbc_page` columns added in migration 050 (nullable, safe no-op for
          // older Postgres replicas where the column isn't yet present — the
          // Supabase client silently drops unknown columns per PostgREST behavior).
          sbc_excerpt: s.sourceExcerpt ?? null,
          sbc_page: s.sourcePage ?? null,
          // Phase 3.2.1 Q-P3.2.1-2 — Pattern P-8 field_provenance JSONB write per
          // service row. One row excerpt covers all cost-sharing fields per Q-P3.2.1-5.
          // Phase 4.0.5: pass dispatchedSections so each entry records searched_sections
          // for verbatim_absent derivation + targeted re-parse coverage.
          ...(haikuService
            ? {
                field_provenance: buildPlanCoveredServiceProvenance(
                  haikuService,
                  "doc_extraction",
                  haikuResult?.dispatchedSections,
                ),
              }
            : {}),
        };
      });

      if (serviceInserts.length > 0) {
        const { error: svcError } = await supabase
          .from("plan_covered_services")
          .upsert(serviceInserts, { onConflict: "insurance_plan_id,service_id,place_of_service" });
        if (svcError) console.error("Failed to insert services:", svcError);
        else servicesCreated = serviceInserts.length;
      }

      // ── S72 commit 5: Plan_doc per-service access-instructions persistence ──
      // Plan_doc Haiku extracts howToAccess per service (e.g., "Find a covered home
      // health agency at mycigna.com/find-care"). Legacy adapter drops howToAccess at
      // the SBCParseResult boundary (commit 2 design); commit 5 wires it into
      // coverage_rules.how_to_access JSONB on plan_covered_services. UI render priority
      // chain in /api/plan/analyze/route.ts: per-service coverage_rules.how_to_access
      // → plan-level customerServicePhone → generic boilerplate fallback. SBC equivalent
      // (Limitations column extraction) deferred to Phase 2 follow-up — SBCParsedService
      // doesn't carry howToAccess today; SBC users get plan-level fallback instead.
      if (planDocHaikuResult && planDocHaikuResult.services.length > 0) {
        try {
          for (const svc of planDocHaikuResult.services) {
            if (!svc.howToAccess) continue;
            const serviceId = slugToId.get(svc.serviceSlug);
            if (!serviceId) continue;
            const { data: existing } = await supabase
              .from("plan_covered_services")
              .select("coverage_rules")
              .eq("insurance_plan_id", targetPlanId)
              .eq("service_id", serviceId)
              .maybeSingle();
            const existingRules = (existing?.coverage_rules as Record<string, unknown> | null) ?? {};
            await supabase
              .from("plan_covered_services")
              .update({ coverage_rules: { ...existingRules, how_to_access: svc.howToAccess } })
              .eq("insurance_plan_id", targetPlanId)
              .eq("service_id", serviceId);
          }
        } catch (err) {
          console.error("[plan-doc-access-instructions] non-fatal write error:", err);
        }
      }

      // ── S72 commit 5: Plan_doc plan-level access-instructions persistence ──
      // Plan_doc Haiku extracts plan-level customer service phone + network finder URL
      // + per-domain contacts. Stored on insurance_plans.metadata.plan_doc_access_instructions
      // for UI render-priority-chain fallback. Pattern 1 #14 user-scoped (this is a
      // user-side row, not canonical); Pattern 1 #9 JSONB-first (no schema change yet —
      // promotes to columns if 3+ services need indexed access).
      if (planDocHaikuResult?.accessInstructions) {
        try {
          const ai = planDocHaikuResult.accessInstructions;
          const accessInstructionsMetadata = {
            customer_service_phone: ai.customerServicePhone.value,
            network_finder_url: ai.networkFinderUrl.value,
            domain_contacts: ai.domainContacts,
          };
          const { data: planRow } = await supabase
            .from("insurance_plans")
            .select("metadata")
            .eq("id", targetPlanId)
            .single();
          const existingMetadata = (planRow?.metadata as Record<string, unknown>) ?? {};
          await supabase
            .from("insurance_plans")
            .update({
              metadata: {
                ...existingMetadata,
                plan_doc_access_instructions: accessInstructionsMetadata,
              },
            })
            .eq("id", targetPlanId);
        } catch (err) {
          console.error("[plan-doc-plan-level-access] non-fatal write error:", err);
        }
      }

      // ── Canonical promotion event — Phase 4.0.6 single code path ────────
      // Per Engineering North Star #1 (Candid_Data_Principles §1) + Pattern 1
      // #14 (§2): user data writes user-scoped only; canonical promotion happens
      // via explicit apply_promotion_event when Pattern 1 #3 corroboration
      // threshold met. Helper invocation is unconditional post-Task 4.0.6-I
      // cleanup (mig 064 RPC value-write branch sunset 2026-05-04). Per
      // Q-P4.0.6-1 LOCK v4 = (B): app-level evaluator. Q-P4.0.6-2 LOCK = (A):
      // advisory lock per (canonical, service, field) inside
      // apply_promotion_event. mig 064 RPC remains callable per Pattern 1 #10
      // hard-delete prohibition; superseded comment in mig 069.
      if (canonicalPlanId && !canonicalNeedsConfirmation) {
        try {
          const candidates = derivePromotionCandidatesFromHaikuResult(haikuResult);
          const result = await commitUploadAndEvaluateCorroboration(supabase, {
            canonicalPlanId: canonicalPlanId!,
            actorUserId: userForFlagCheck?.id ?? doc.user_id,
            fireSource: "process-plan",
            candidates,
          });

          console.log(
            `[canonical-promotion] canonical=${canonicalPlanId} candidates=${candidates.length} fired=${result.promotionsFired} challenges=${result.challengeCandidates} errors=${result.errors.length}`,
          );
          if (result.errors.length > 0) {
            console.error("[canonical-promotion] errors:", result.errors);
          }
        } catch (err) {
          console.error("[canonical-promotion] Helper error (non-fatal):", err);
        }

        // ── S72 commit 4: canonical_haiku_extractions cite-grade citations write ──
        // Closes CF-20 cite-grade gap for smart-skipped users (post-CF-40 v3).
        // Writes per-field cite-grade Pattern P-8 source_excerpts to canonical-side
        // append-only table. Dispute-letter logic (evidence-resolver.ts) falls back
        // here when user's own row lacks excerpt. Non-fatal on insert error.
        try {
          const userId = userForFlagCheck?.id ?? doc.user_id;
          // Look up document file_hash for source_user_doc_hash provenance trail.
          const { data: docMeta } = await supabase
            .from("documents")
            .select("file_hash")
            .eq("id", doc.id)
            .maybeSingle();
          const sourceUserDocHash = (docMeta?.file_hash as string | null | undefined) ?? null;

          // SBC Haiku-first path (when sbc_parser_v1 flag ON + usedNewSBCParser=true)
          if (haikuResult) {
            const sbcRows = extractRowsFromSBCHaikuResult(haikuResult);
            const sbcWrite = await writeCanonicalHaikuExtractions(supabase, {
              canonicalPlanId,
              userId,
              documentId: doc.id,
              sourceUserDocHash,
              haikuRunId: generateHaikuRunId("sbc", doc.id),
              parserKind: "sbc",
              rows: sbcRows,
            });
            console.log(
              `[canonical-haiku-extractions] sbc canonical=${canonicalPlanId} cite_grade_rows_written=${sbcWrite.rowsWritten}`,
            );
          }

          // Plan_doc Haiku-first path (when plan_doc_parser_v2 flag ON)
          if (planDocHaikuResult) {
            const planDocRows = extractRowsFromPlanDocHaikuResult(planDocHaikuResult);
            const planDocWrite = await writeCanonicalHaikuExtractions(supabase, {
              canonicalPlanId,
              userId,
              documentId: doc.id,
              sourceUserDocHash,
              haikuRunId: generateHaikuRunId("plan_doc", doc.id),
              parserKind: "plan_doc",
              rows: planDocRows,
            });
            console.log(
              `[canonical-haiku-extractions] plan_doc canonical=${canonicalPlanId} cite_grade_rows_written=${planDocWrite.rowsWritten}`,
            );
          }
        } catch (err) {
          console.error("[canonical-haiku-extractions] non-fatal write error:", err);
        }
      }
    }

    // ── Canonical service inheritance: fill gaps from community data ────────
    // When a plan links to a canonical, inherit any services the user doesn't have yet.
    // Phase 3.2.1 — propagate field_provenance from canonical to inherited row to
    // preserve Pattern P-8 cite chain. The inherited row's provenance reflects the
    // ORIGINAL evidence (some other user's SBC upload that seeded the canonical),
    // not the inheritance event — Phase 4 dispute letter cite is still valid because
    // the source_excerpt traces back to the actual document that captured the value.
    //
    // Phase 4.0.6 (Q-P4.0.6-7 LOCK): inheritance fires ONLY from corroborated
    // canonical rows (confidence ≥ cross_user_inheritance_min_confidence;
    // default 0.9; runtime-tunable via canonical_promotion_event_v1.config).
    // Pre-corroboration users see "we don't have community-verified data on
    // this yet" rather than another user's single-source assertion. Aligns
    // with Pattern 1 #14 cross-user inheritance implication. Always-on
    // post-Task 4.0.6-I cleanup (legacy unfiltered branch sunset).
    if (canonicalPlanId && !canonicalNeedsConfirmation && !canonicalIsNew) {
      try {
        const { data: flagRow } = await supabase
          .from("feature_flag_rules")
          .select("config")
          .eq("flag_key", "canonical_promotion_event_v1")
          .single();
        const cfg = (flagRow?.config as Record<string, unknown> | null) ?? null;
        const minConf = cfg?.cross_user_inheritance_min_confidence;
        const inheritanceMinConfidence = typeof minConf === "number" && minConf >= 0 ? minConf : 0.9;

        const { data: canonicalServices } = await supabase
          .from("canonical_plan_services")
          .select("service_slug, copay, coinsurance, deductible_applies, is_covered, requires_prior_auth, confidence, field_provenance")
          .eq("canonical_plan_id", canonicalPlanId)
          .gte("confidence", inheritanceMinConfidence);

        if (canonicalServices && canonicalServices.length > 0) {
          // Get user's existing service slugs
          const { data: userServices } = await supabase
            .from("plan_covered_services")
            .select("service_id, service_catalog!inner(slug)")
            .eq("insurance_plan_id", targetPlanId);

          const existingSlugs = new Set(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            userServices?.map((s: any) => s.service_catalog?.slug ?? s.service_catalog?.[0]?.slug).filter(Boolean) || []
          );

          const missing = canonicalServices.filter(cs => !existingSlugs.has(cs.service_slug));

          if (missing.length > 0) {
            let inherited = 0;
            for (const cs of missing) {
              const { data: svc } = await supabase
                .from("service_catalog")
                .select("id")
                .eq("slug", cs.service_slug)
                .is("merged_into_id", null)
                .single();

              if (svc) {
                const { error: inhErr } = await supabase.from("plan_covered_services").upsert({
                  insurance_plan_id: targetPlanId,
                  service_id: svc.id,
                  place_of_service: "any",
                  in_copay: cs.copay,
                  in_coinsurance: cs.coinsurance,
                  in_deductible_applies: cs.deductible_applies,
                  covered: cs.is_covered,
                  prior_auth_required: cs.requires_prior_auth,
                  confidence: Math.min(cs.confidence, 0.8), // Inherited data slightly lower confidence
                  source: "canonical_inherited" as const,
                  // Phase 3.2.1 — preserve Pattern P-8 cite chain across inheritance.
                  // canonical_plan_services row's field_provenance traces back to the
                  // original SBC user's source_excerpt; that's still the citable evidence
                  // for this user's plan. Defaults to {} when canonical row predates
                  // Phase 3.2.1 (legacy seed without field_provenance).
                  field_provenance: cs.field_provenance ?? {},
                }, { onConflict: "insurance_plan_id,service_id,place_of_service" });
                if (!inhErr) inherited++;
              }
            }
            if (inherited > 0) {
              console.log(`[canonical-plan] Inherited ${inherited} services from canonical ${canonicalPlanId} to user plan ${targetPlanId}`);
            }
          }
        }
      } catch (inheritErr) {
        console.warn("[canonical-plan] Service inheritance failed (non-fatal):", inheritErr);
      }
    }

    // ── Post-extraction tracking for dedup sampling ─────────────────────────
    if (canonicalPlanId && !canonicalNeedsConfirmation) {
      try {
        const { recordExtractionResult } = await import("@/lib/plan/extraction-dedup");
        // Get file hash from document record
        const { data: docForHash } = await supabase
          .from("documents")
          .select("file_hash")
          .eq("id", documentId)
          .single();

        const extractedSlugs = parseResult.services
          .filter((s) => s.confidence >= 0.5)
          .map((s) => s.serviceSlug);

        // CF-40 (Session 74): pass plan-identity cost values for parse-event stability
        // counter. recordExtractionResult compares against canonical's
        // last_haiku_extracted_values snapshot; match → counter++; mismatch → reset to 1.
        // Smart-skip (next upload on this canonical) gates on haiku_output_stable=TRUE
        // which flips when counter >= 3.
        const haikuPlanIdentityValues = {
          in_deductible_individual: (planInsert.in_deductible_individual as number | null | undefined) ?? null,
          in_deductible_family: (planInsert.in_deductible_family as number | null | undefined) ?? null,
          in_oop_max_individual: (planInsert.in_oop_max_individual as number | null | undefined) ?? null,
          in_oop_max_family: (planInsert.in_oop_max_family as number | null | undefined) ?? null,
        };

        await recordExtractionResult(
          supabase,
          documentId,
          canonicalPlanId,
          doc.user_id,
          docForHash?.file_hash || null,
          extractedSlugs,
          haikuPlanIdentityValues,
        );
      } catch (trackErr) {
        console.error("[process-plan] Extraction tracking error (non-fatal):", trackErr);
      }
    }

    // ── Finalize document ───────────────────────────────────────────────────
    // Phase 4.0.5: `processing_ocr_text` retained post-process (was previously
    // cleared) so /api/plan/reparse-field can dispatch Haiku on un-searched
    // sections without re-OCR. Forward-only — pre-Phase-4.0.5 docs have null
    // and fall back to upload-different-doc affordance per Q-P4.0.5-7 LOCK.
    await supabase.from("documents").update({
      status: "processed",
      linked_insurance_plan_id: targetPlanId,
      processing_step: null,
      processing_extracted_services: null,
    }).eq("id", documentId);

    // S78 — async ingestion: fire parse-complete email for large plan_doc/SBC.
    // Helper internally gates on pageCount > 30 + Resend idempotency key prevents
    // double-sends on QStash retry. Fail-soft.
    try {
      const { sendParseCompleteEmail } = await import("@/lib/email/onboarding-emails");
      await sendParseCompleteEmail(supabase, documentId);
    } catch (err) {
      console.error("[process-plan] parse-complete email (non-fatal):", err);
    }

    console.log(`[process-plan] Done. Plan=${targetPlanId}, services=${servicesCreated}, mismatch=${mismatchData?.type || "none"}, merged=${!!mergeIntoExistingPlan}`);

    return {
      success: true,
      planId: targetPlanId,
      servicesCreated,
      planData: {
        planName: planInsert.plan_name,
        planType: planInsert.plan_type,
        inDeductible: planInsert.in_deductible_individual,
        outDeductible: planInsert.out_deductible_individual,
        inOopMax: planInsert.in_oop_max_individual,
        outOopMax: planInsert.out_oop_max_individual,
        servicesExtracted: servicesCreated,
      },
      parseWarnings: parseResult.parseWarnings,
      insurerMismatch: mismatchData,
      yearRollover,
    };
  } catch (err) {
    console.error("[process-plan] Error:", err);
    await supabase.from("documents").update({ status: "error", processing_error: String(err) }).eq("id", documentId);
    return { success: false, error: "Plan processing failed. Please try again." };
  }
}

async function notifyAndFlagForReview(
  supabase: SupabaseClient,
  documentId: string,
  classification: { classifiedType: string; confidence: number },
  doc: { id: string; user_id: string; file_name: string },
  reason?: string
) {
  try {
    const { notifyAdminForReview } = await import("@/lib/notifications");
    const { data: profile } = await supabase.from("profiles").select("email").eq("user_id", doc.user_id).single();
    await notifyAdminForReview(documentId, classification.classifiedType, classification.confidence, doc.file_name, profile?.email || "unknown");
  } catch { /* non-critical */ }
  await supabase.from("documents").update({
    status: "pending_review",
    processing_error: reason || "Haiku extraction failed or returned no services",
  }).eq("id", documentId);
}
