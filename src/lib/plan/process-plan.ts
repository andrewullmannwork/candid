/**
 * Plan document processing — single-pass.
 * Runs classify → Haiku extract → DB save in one invocation.
 * Vercel Pro maxDuration=60 gives enough headroom for large documents.
 */

import { createServerClient } from "@/lib/supabase/server";
import { parsePlanDocumentWithMeta } from "@/lib/plan/plan-doc-parser";
import { getUserContextByPk } from "@/lib/users/resolve-user-by-pk";
import type { PlanDocHaikuParseResult } from "@/lib/plan_doc/types";
import {
  writeCanonicalHaikuExtractions,
  generateHaikuRunId,
  extractRowsFromSBCHaikuResult,
  extractRowsFromPlanDocHaikuResult,
} from "@/lib/parser/canonical-haiku-extractions";
import type { SBCPlanIdentity } from "@/lib/sbc/types";
import type { PlanDocPlanIdentity } from "@/lib/plan_doc/types";
import type { ClassifiedDocType } from "@/lib/classifier";
import type { ForcedReparseReason } from "@/lib/parser/cf40-v4";
import { extractServicesWithClaude } from "@/lib/plan/claude-extractor";
import {
  findOrCreateCanonicalPlan,
  linkPlanToCanonical,
  resolveCanonicalCandidate,
} from "@/lib/plan/canonical-match";
import {
  resolvePlanIdentity,
  identityAllowsMerge,
  shouldAssembleStub,
  STUB_ASSEMBLY_REASON,
  CANONICAL_IDENTITY_CONFIDENCE_FLOOR,
} from "@/lib/plan/plan-identity";
import { recordCostEvent } from "@/lib/cost/parse-cost-events";
import { matchInsurerWithPlanFallback, matchInsurerCatalog } from "@/lib/plan/insurer-match";
import { isFeatureEnabled, readFeatureFlagConfig } from "@/lib/config/product-flags";
import { routePlanDocServices } from "@/lib/plan_doc/thesaurus-routing";
import type { RawService } from "@/lib/plan_doc/haiku-prompts/services-cost-sharing";
import { applyPlanCoverageCell, mergeServiceCoverageRules, coerceComponent } from "@/lib/plan/coverage-targeting";
import { applyDocSupplementMerge } from "@/lib/plan/plan-merge";
import {
  PLAN_MERGE_RECEIPT_VERSION,
  MAX_RECEIPT_CELLS,
  type PlanMergeReceipt,
} from "@/lib/plan/merge-receipt";
import { derivePlanTierLabel } from "@/lib/claims/service-resolver";
import { votedParseSBC } from "@/lib/sbc/voted-parser";
import type { VotedParseSBCResult } from "@/lib/sbc/voted-parser";
import { translateHaikuToLegacy } from "@/lib/sbc/legacy-adapter";
import { validatePlanFields, validatePlanField } from "@/lib/plan/garbage-validators";
import { normalizeCoinsuranceForStorage } from "@/lib/billing/coinsurance";
import type { SBCHaikuService, SBCParseResult, SBCParsedService } from "@/lib/sbc/types";
import {
  buildPlanCoveredServiceProvenance,
  buildPlanDocServiceProvenance,
  buildSBCPlanIdentityProvenance,
  buildPlanDocIdentityProvenance,
} from "@/lib/parser/provenance-builders";
import { loadValidServiceSlugs, enqueueUnknownServiceSlug } from "@/lib/parser/service-catalog-slugs";
import { finalizePlanActivation } from "@/lib/claims/claim-plan-link";
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
  /** S195 EOC-RESUME: this invocation checkpointed + re-enqueued itself; the
   * parse continues in a later invocation. Not an error, not completion. */
  resumeRequested?: boolean;
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

// (S289) inferServiceCategory deleted — a zero-call-site regex slug→category
// classifier whose rules contradicted the catalog (dental/vision → "other").
// Category is service_catalog.category, joined via the pcs FK or resolved via
// src/lib/plan/catalog-identity.ts for slug-keyed canonical rows.

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
  // `seedMode` (cold-start regen, S253): suppress the per-doc CHURN + NOTIFICATIONS that would be
  // catastrophic ×~1,200 (active-plan pointer/deactivate, parse_cost_events, review-queue, email).
  // KEEPS the insurance_plans/plan_covered_services persist + canonical writes — the canonical
  // promotion READS those rows (expandPerServiceCandidates); suppressing them would starve it.
  // `seedTargetPlanId` (required with seedMode) routes the persist to the doc's EXISTING canonical-
  // linked plan + supplies the canonical from its preserved link (the empty-identity override can't).
  options?: { skipCanonical?: boolean; thesaurusRoutingOverride?: boolean; seedMode?: boolean; rawServicesOverride?: RawService[]; coverageDims?: boolean; seedTargetPlanId?: string; planIdentityOverride?: PlanDocPlanIdentity }
): Promise<ProcessPlanResult> {
  try {
    // seedMode (cold-start regen) targets an EXISTING plan by id; without it the persist falls through
    // to the production INSERT and orphans an empty-identity plan. Fail loud, don't silently orphan.
    if (options?.seedMode && !options.seedTargetPlanId) {
      throw new Error("seedMode requires seedTargetPlanId — cold-start regen targets an existing plan");
    }
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
    const userForFlagCheck = await getUserContextByPk(supabase, doc.user_id, "process-plan:flags+slug-enqueue");
    const sbcParserV1Enabled = !isFullPlanDoc
      ? await isFeatureEnabled("sbc_parser_v1", userForFlagCheck?.email ?? undefined)
      : false;
    // Ing-H (CF-44, S129): resolve cf44_selective_self_check flag — when ON,
    // parser fires self-check ONLY when column_wrap_score > 0.6. Default ON
    // in PROD per S129 "test on prod" decision; missing flag falls back to
    // false (preserves current always-fire behavior).
    const selectiveSelfCheckEnabled = await isFeatureEnabled(
      "cf44_selective_self_check",
      userForFlagCheck?.email ?? undefined,
    );
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
          selectiveSelfCheckEnabled,
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
        // A3 (S235): drive the PROMPT leg (rawLabel emission) from the SAME override as the routing
        // leg (~line 335) so the in-vivo smoke runs the whole synonym path flag-ON without flipping
        // global PROD. PROD callers don't pass thesaurusRoutingOverride → the prompt reads the live flag.
        thesaurusPhase1a: options?.thesaurusRoutingOverride,
        // S253 cold-start seed regen: deterministic Stage C inject + pinned coverage_dims.
        rawServicesOverride: options?.rawServicesOverride,
        coverageDims: options?.coverageDims,
        planIdentityOverride: options?.planIdentityOverride,
      });
      parseResult = planDocResult.legacy;
      planDocHaikuResult = planDocResult.haiku;

      // ── Thesaurus Phase 1a (T3a) — plan-doc slug routing ────────────────────
      // ALWAYS canonicalize each extractor slug via the service_catalog rename-map
      // (dead→live). The prompt still emits deprecated slugs (mig 148+); without this
      // they resolve to a merged catalog row consumer-reads exclude → service dropped.
      // Pure correctness, no exposure risk → NOT flag-gated (S175). The trustworthy
      // signature-cache OVERRIDE (synonym routing) stays gated by `thesaurus_phase1a_v1`
      // (synonym-inferred coverage is exposure-held for Phase 2/6).
      // A3: routing-time override (internal; lets the stamp/E2E smoke run synonym routing
      // flag-ON WITHOUT flipping the global flag in PROD). Defaults to the global flag, so
      // every real caller (none pass the override) is byte-identical.
      const cacheRoutingOn =
        options?.thesaurusRoutingOverride ??
        (await isFeatureEnabled("thesaurus_phase1a_v1", userForFlagCheck?.email ?? undefined));
      if (planDocResult.haiku && planDocResult.legacy.services.length > 0) {
        const haikuResult = planDocResult.haiku;
        const routed = await routePlanDocServices({
          supabase,
          userId: doc.user_id,
          legacyServices: planDocResult.legacy.services,
          haikuServices: haikuResult.services,
          cacheRoutingEnabled: cacheRoutingOn,
        });
        if (routed) {
          console.log(
            `[process-plan] thesaurus routing: ${routed.cacheWins} cache-win(s), ${routed.slugChanged} slug change(s) / ${routed.total} service(s)`,
          );
        }
      }
    } else {
      // SBC classification with sbc_parser_v1 OFF — explicit failure.
      // The flag stays in code as a kill-switch for debugging; flipping a specific
      // user OFF will surface this error rather than silently degrade their data.
      throw new Error("SBC_PARSER_DISABLED: sbc_parser_v1 flag is OFF for this user");
    }

    // ── Plan identity safety net (S90 Bug X) ─────────────────────────────────
    // The Haiku-first SBC parser (sbc_parser_v1) AND the legacy regex
    // parsePlanDocument both stochastically return null on plan-identity fields
    // (planName, insurer, planType, planYear) on real fixtures — observed
    // empirically at S90 Phase 1.1 (BSCA) + 1.2 (Ambetter). Previously this
    // fallback was gated on `!usedNewSBCParser`, assuming the new SBC parser
    // would always extract identity natively. That assumption was wrong.
    //
    // Fix: when ANY of plan_name / insurer_name / plan_type / plan_year is
    // null after the parser ran (regardless of which parser ran), call the
    // dedicated Haiku plan-identifier extractor (~$0.001 marginal cost) which
    // uses a tighter prompt focused on the document header. `??=` preserves
    // any non-null values the parser DID extract so we never overwrite a
    // successful parser result with potentially-wrong fallback data.
    //
    // Bug Y at the merge step below relies on this: if both parser AND this
    // fallback leave insurer_name null, the merge logic treats it as a
    // mismatch (don't silently merge into the user's active plan).
    const needsIdentityRecovery = !parseResult.plan.plan_name
      || !parseResult.plan.insurer_name
      || !parseResult.plan.plan_year
      || !parseResult.plan.plan_type;
    // seedMode (cold-start regen): identity is owned by the dedicated identity phase (§19-D) + the
    // existing plan's identity is PRESERVED — skip the Haiku identity-recovery LLM (determinism).
    if (needsIdentityRecovery && !options?.seedMode) {
      try {
        const { extractPlanIdentifiersWithHaiku } = await import("@/lib/plan/extraction-dedup");
        const haikuIds = await extractPlanIdentifiersWithHaiku(ocrText);
        parseResult.plan.plan_name ??= haikuIds.planName ?? null;
        parseResult.plan.insurer_name ??= haikuIds.insurer ?? null;
        parseResult.plan.plan_type ??= haikuIds.planType ?? null;
        parseResult.plan.plan_year ??= haikuIds.planYear ?? null;
        console.log(
          "[process-plan] Plan-identity safety net (Haiku fallback):",
          `plan_name=${parseResult.plan.plan_name ?? "null"}`,
          `insurer=${parseResult.plan.insurer_name ?? "null"}`,
          `plan_type=${parseResult.plan.plan_type ?? "null"}`,
          `plan_year=${parseResult.plan.plan_year ?? "null"}`,
        );
      } catch (haikuErr) {
        console.warn("[process-plan] Plan-identity recovery failed:", haikuErr);
      }
    }

    // ── Ing-B: Garbage-pattern validators (CF-63 RC-6) ───────────────────────
    // Single discipline point for both parser paths (SBC + plan-doc) + the
    // Haiku identity safety net above. Nulls plan-identity fields that match
    // known-garbage regex patterns from OCR column-wrap drift (HIOS IDs / FAQ
    // text / footer boilerplate sitting in plan_name / insurer_name /
    // metal_tier / group_number slots) and pushes a structured warning into
    // parseResult.parseWarnings so the value never reaches insurance_plans
    // or canonical_plans. Pattern-to-field map is curated (not all-patterns-
    // apply-to-all-fields) — see src/lib/plan/garbage-validators.ts.
    //
    // Gated by `garbage_validators_enabled` (mig 121, default ON). Empty
    // pattern fires + flag ON = no-op when no parser output matches.
    const garbageValidatorsEnabled = await isFeatureEnabled(
      "garbage_validators_enabled",
      userForFlagCheck?.email ?? undefined,
    );
    if (garbageValidatorsEnabled) {
      const garbageCheck = validatePlanFields(parseResult.plan);
      if (garbageCheck.warnings.length > 0) {
        parseResult.plan = garbageCheck.cleanedPlan;
        parseResult.parseWarnings = [
          ...(parseResult.parseWarnings || []),
          ...garbageCheck.warnings,
        ];
        console.warn(
          "[process-plan] Garbage-pattern validator nulled fields:",
          garbageCheck.warnings.join(", "),
        );
      }
      // CF-63 RC-4 (S128): metalTier flows separately from parseResult.plan
      // (not on InsurancePlanInsert schema; lands on canonical_plans.metal_level
      // via findOrCreateCanonicalPlan). Same garbage-pattern defense applies.
      const metalTierCheck = validatePlanField(parseResult.metalTier, "metal_tier");
      if (metalTierCheck.warning) {
        parseResult.metalTier = null;
        parseResult.parseWarnings = [
          ...(parseResult.parseWarnings || []),
          metalTierCheck.warning,
        ];
        console.warn(
          "[process-plan] Garbage-pattern validator nulled metal_tier:",
          metalTierCheck.warning,
        );
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
    //
    // S93 (closes F.14 fast-follow) — also skip when the Haiku-first plan_doc
    // parser ran (plan_doc_parser_v2 ON). The toLegacyPlanDocResult adapter
    // already converted the parser's per-section services into the legacy
    // SBCParsedService shape on parseResult.services; calling the legacy
    // claude-extractor a second time either overwrites those values with its
    // own (~49% recall regex+claude) output or crashes mid-extract on
    // unexpected Haiku response shapes (Cigna 2026-05-15 PROD: TypeError
    // e.replace is not a function bricked the run + produced partial_no_services
    // even though plan-identity recovered + Haiku-first had services available).
    //
    // Skip rule: isFullPlanDoc + planDocHaikuResult emitted >= 1 service.
    // When Haiku-first ran but extracted 0 services, fall through to the
    // claude-extractor as a recovery path (the legacy regex+claude can find
    // services the Haiku-first prompt missed in some narrative formats).
    const usedHaikuFirstPlanDoc =
      isFullPlanDoc &&
      planDocHaikuResult !== null &&
      parseResult.services.length > 0;
    if (usedNewSBCParser) {
      // New SBC Haiku parser already populated services + appealsContact;
      // skip the legacy claude-extractor call to avoid double-extraction.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parseResult as any).appealsContact = haikuFirstAppealsContact;
      console.log(`[process-plan] sbc_parser_v1: skipped legacy claude-extractor (Haiku-first produced ${parseResult.services.length} services)`);
    } else if (usedHaikuFirstPlanDoc) {
      // Haiku-first plan_doc parser already populated services via
      // toLegacyPlanDocResult adapter. Per F.14 fast-follow, the legacy
      // claude-extractor is the deprecation target on this path; skipping
      // here closes the loop. appealsContact stays null on this path (the
      // plan_doc parser's accessInstructions contact info isn't currently
      // adapted into the legacy shape — small follow-up if telemetry shows
      // PROD users miss it).
      console.log(
        `[process-plan] usedHaikuFirstPlanDoc: skipped legacy claude-extractor (Haiku-first produced ${parseResult.services.length} services)`,
      );
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
        // S92 Stage 2 — no-dead-end fallback. Even though service extraction
        // failed, parseResult.plan may have plan-identity scalars from earlier
        // regex / Haiku passes. If ANY plan-identity field is populated,
        // treat as partial_success (status=processed; user sees "Half the
        // picture's here" UI nudge to re-upload). Otherwise genuine_failure.
        const hasAnyPlanIdentity = Boolean(
          parseResult.plan.plan_name ||
            parseResult.plan.plan_type ||
            parseResult.plan.in_deductible_individual ||
            parseResult.plan.in_oop_max_individual,
        );
        const outcome: NoDeadEndOutcome = hasAnyPlanIdentity ? "partial_success" : "genuine_failure";
        await notifyAndFlagForReview(supabase, documentId, classification, doc, reason, outcome);
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
          parseWarnings: [
            ...(parseResult.parseWarnings || []),
            outcome === "partial_success"
              ? "Services extraction returned 0 rows; plan-identity preserved (partial_success)"
              : "Service extraction requires admin review",
          ],
        };
      }
    } catch (err) {
      const reason = `Haiku exception: ${err instanceof Error ? err.message : String(err)}`;
      console.error("[process-plan]", reason);
      // S92 Stage 2 — Haiku threw entirely. If parseResult.plan has any plan-identity
      // from earlier regex extraction, partial_success; else genuine_failure.
      const hasAnyPlanIdentity = Boolean(
        parseResult?.plan?.plan_name ||
          parseResult?.plan?.plan_type ||
          parseResult?.plan?.in_deductible_individual ||
          parseResult?.plan?.in_oop_max_individual,
      );
      const outcome: NoDeadEndOutcome = hasAnyPlanIdentity ? "partial_success" : "genuine_failure";
      await notifyAndFlagForReview(supabase, documentId, classification, doc, reason, outcome);
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
    // S94 B1 — plan_doc path now writes plan-identity Pattern P-8 provenance.
    // Before this fix, the plan_doc Haiku-first parser path left planIdentityProvenance=null
    // → insurance_plans.field_provenance defaulted to {} → consumer-read filter marked
    // every field "estimated" instead of "verified" even when cite-grade was 100% via
    // the harness. Silent regression since `unified_plan_doc_parser_v1` flag went global
    // ON during S93 ship (2026-05-15).
    const planIdentityProvenance = haikuResult
      ? buildSBCPlanIdentityProvenance(haikuResult.planIdentity, "doc_extraction", haikuResult.dispatchedSections)
      : planDocHaikuResult
        ? buildPlanDocIdentityProvenance(
            planDocHaikuResult.planIdentity,
            "doc_extraction",
            planDocHaikuResult.dispatchedSections,
          )
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
      // S320 — mig-231 stamp contract: this expression-form activation shipped
      // unstamped (the guard's literal scan couldn't see `!isComparisonUpload`;
      // run-4's plan landed active with activated_at null). Mirrors is_active.
      activated_at: !isComparisonUpload ? new Date().toISOString() : null,
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
      /** S292 — the resolver's verdict, so the UI can pick its prompt state. */
      identity?: {
        verdict: "different" | "uncertain";
        reason: string;
        evidence: string;
        existingPlanId: string;
      };
    } | null = null;

    // ── S292 item 4A — plan identity, resolved (flag `plan_identity_resolver_v1`) ─
    // The legacy check below compares the parse against the PROFILE's insurer +
    // plan_name with a five-word-strip normalizer. It is wrong in both
    // directions, and one real account proved both on the same day:
    //
    //   FALSE NEGATIVE — an upload resolving to a genuinely DIFFERENT catalog
    //   plan was silently supplement-merged into the active plan because the
    //   profile's plan_name was empty, so the comparison never ran. Every later
    //   bill is then audited against a blend of two policies.
    //
    //   FALSE POSITIVE — a card and an SBC that provably resolve to the SAME
    //   canonical plan were flagged as a mismatch because the strings differ.
    //
    // Two structural fixes ride along, independent of the resolver itself:
    //
    //   1. We compare against the ACTIVE PLAN ROW, not the profile. The profile
    //      is a denormalized copy that goes stale (and was empty in the real
    //      false-negative case).
    //   2. ONE lookup feeds both the identity decision and the merge target.
    //      Previously the mismatch check read `profiles` while the merge target
    //      read `insurance_plans` — two sources, so we could decide "same plan"
    //      about one row and then merge into a different one.
    //
    // WHAT THE RESOLVER CAN ACTUALLY SEE HERE. Rules 2 (HIOS) and 3 (group +
    // insurer) need those identifiers on BOTH sides; the plan parsers do not
    // extract either today, so on this path they are dormant and the live rungs
    // are canonical-match, insurer-differs, canonical-differs, name-differs and
    // uncertain. The facts are read from `planInsert` anyway, so both rungs
    // light up on their own the day the parser starts emitting them.
    //
    // MERGE POLICY: only `same` merges. `different` AND `uncertain` both hold
    // the upload as an inactive plan and ask — preserve-on-uncertainty, the
    // resolver's own doctrine. That is a real behaviour change: today a parse
    // with two empty names falls through and merges. Holding it is why the flag
    // exists, and the S291 stranded-plan recovery (`/api/plan/stranded` + the
    // banner) is what keeps a held plan visible rather than lost.
    let identityTargetPlan: { id: string; plan_year: number | null } | null = null;
    let identityDecided = false;
    /**
     * The "we merged this into your existing plan" receipt (verdict `same`).
     * Rides `documents.insurer_mismatch` — already the channel the status route
     * exposes and the upload surface polls — rather than opening a second one.
     * `mismatch: false` keeps every existing consumer's `insurerMismatch.mismatch`
     * check false, so this is additive: nothing that reads the column today can
     * mistake a match for a mismatch.
     */
    let identityMatchRecord: {
      mismatch: false;
      identity: {
        verdict: "same";
        reason: string;
        evidence: string;
        existingPlanId: string;
        existingPlanName: string | null;
      };
    } | null = null;

    const identityResolverOn =
      !options?.seedMode &&
      !isComparisonUpload &&
      (await isFeatureEnabled("plan_identity_resolver_v1", userForFlagCheck?.email ?? undefined));

    if (identityResolverOn) {
      // Deterministic pick: `.single()` THROWS on multi-active rows and the old
      // code then fell through to the create-branch silently (the S286 landmine).
      // Order instead, take the newest activation, and say so out loud.
      const { data: activePlanRows } = await supabase
        .from("insurance_plans")
        .select(
          "id, plan_name, insurer_name, plan_year, group_number, hios_id, canonical_plan_id, canonical_match_confidence, source, activated_at, updated_at",
        )
        .eq("user_id", doc.user_id)
        .eq("is_active", true)
        .order("activated_at", { ascending: false, nullsFirst: false })
        .order("updated_at", { ascending: false });

      const activePlan = activePlanRows?.[0] ?? null;
      if (activePlanRows && activePlanRows.length > 1) {
        console.warn(
          `[plan-identity] ${activePlanRows.length} ACTIVE plans for user ${doc.user_id} — comparing against the most recently activated (${activePlan?.id}). The others are invisible to this decision.`,
        );
      }

      if (!activePlan) {
        // Nothing on file to be the same as or different from. The create-plan
        // branch below owns this case, exactly as it does today.
        identityDecided = true;
        console.log(`[plan-identity] no active plan for user ${doc.user_id} — first plan, nothing to compare (doc=${documentId})`);
      } else {
        // Ship Gate #6 — the floor is flag config, not a constant in the source.
        const floor = await readFeatureFlagConfig(
          "plan_identity_resolver_v1",
          "canonical_confidence_floor",
          CANONICAL_IDENTITY_CONFIDENCE_FLOOR,
        );

        // `resolvePlanIdentity` is pure and synchronous by design, so insurer
        // identity is resolved to a catalog id HERE — that is what makes 'UHC'
        // and 'UnitedHealthcare Insurance Company' one company rather than two.
        const [existingInsurerCatalog, parsedInsurerCatalog] = await Promise.all([
          activePlan.insurer_name
            ? matchInsurerCatalog(supabase, activePlan.insurer_name as string)
            : Promise.resolve(null),
          planInsert.insurer_name
            ? matchInsurerCatalog(supabase, planInsert.insurer_name as string)
            : Promise.resolve(null),
        ]);

        // The parsed document's catalog identity, resolved READ-ONLY. The
        // writing path (`findOrCreateCanonicalPlan`) does not run until ~350
        // lines below — after the merge it is supposed to be informing — so
        // asking it here would both be too late and create a canonical as a
        // side effect of a question. A candidate still awaiting user
        // confirmation is deliberately NOT used as identity evidence: an
        // unconfirmed guess must not decide whether two plans are the same.
        let parsedCanonicalId: string | null = null;
        let parsedCanonicalConfidence: number | null = null;
        if (parsedInsurerCatalog?.id && planInsert.plan_name) {
          const candidate = await resolveCanonicalCandidate(supabase, {
            insurerId: parsedInsurerCatalog.id,
            planName: planInsert.plan_name as string,
            planType: (planInsert.plan_type as string | null) ?? undefined,
            state: (planInsert.state as string | null) ?? undefined,
            planYear: (planInsert.plan_year as number | null) ?? undefined,
            groupNumber: (planInsert.group_number as string | null) ?? undefined,
            hiosId: (planInsert.hios_id as string | null) ?? undefined,
            deductible: (planInsert.in_deductible_individual as number | null) ?? undefined,
            oopMax: (planInsert.in_oop_max_individual as number | null) ?? undefined,
          });
          if (candidate.canonicalPlanId && !candidate.needsConfirmation) {
            parsedCanonicalId = candidate.canonicalPlanId;
            parsedCanonicalConfidence = candidate.confidence;
          }
        }

        const identity = resolvePlanIdentity(
          {
            canonicalPlanId: (activePlan.canonical_plan_id as string | null) ?? null,
            canonicalConfidence: (activePlan.canonical_match_confidence as number | null) ?? null,
            hiosId: (activePlan.hios_id as string | null) ?? null,
            groupNumber: (activePlan.group_number as string | null) ?? null,
            insurerName: (activePlan.insurer_name as string | null) ?? null,
            insurerCatalogId: existingInsurerCatalog?.id ?? null,
            planName: (activePlan.plan_name as string | null) ?? null,
          },
          {
            canonicalPlanId: parsedCanonicalId,
            canonicalConfidence: parsedCanonicalConfidence,
            hiosId: (planInsert.hios_id as string | null) ?? null,
            groupNumber: (planInsert.group_number as string | null) ?? null,
            insurerName: (planInsert.insurer_name as string | null) ?? null,
            insurerCatalogId: parsedInsurerCatalog?.id ?? null,
            planName: (planInsert.plan_name as string | null) ?? null,
          },
          { canonicalConfidenceFloor: floor },
        );

        // Ship Gate #7 — telemetry on EVERY decision, fire AND non-fire. Without
        // the non-fires we cannot tell a resolver that is working from one that
        // is answering "uncertain" to everything because its inputs are null.
        console.log(
          `[plan-identity] verdict=${identity.verdict} reason=${identity.reason} floor=${floor} ` +
            `doc=${documentId} activePlan=${activePlan.id} ` +
            `existingCanonical=${activePlan.canonical_plan_id ?? "none"}@${activePlan.canonical_match_confidence ?? "unscored"} ` +
            `parsedCanonical=${parsedCanonicalId ?? "none"}@${parsedCanonicalConfidence ?? "unscored"} ` +
            `existingInsurerCatalog=${existingInsurerCatalog?.id ?? "none"} parsedInsurerCatalog=${parsedInsurerCatalog?.id ?? "none"} ` +
            `— ${identity.evidence}`,
        );

        identityDecided = true;
        if (identityAllowsMerge(identity.verdict)) {
          identityTargetPlan = {
            id: activePlan.id as string,
            plan_year: (activePlan.plan_year as number | null) ?? null,
          };
          // A successful merge wrote NOTHING the user could see: the upload flow
          // only ever recorded exceptions (mismatch / rollover / pending match),
          // so "we quietly folded this document into your plan" was invisible and
          // — more to the point — unappealable. Record the match so the upload
          // surface can say which plan absorbed the document, and so the escape
          // hatch has something to act on.
          identityMatchRecord = {
            mismatch: false,
            identity: {
              verdict: "same",
              reason: identity.reason,
              evidence: identity.evidence,
              existingPlanId: activePlan.id as string,
              existingPlanName: (activePlan.plan_name as string | null) ?? null,
            },
          };
        } else if (
          shouldAssembleStub({
            reason: identity.reason,
            existingSource: (activePlan.source as string | null) ?? null,
            existingPlanName: (activePlan.plan_name as string | null) ?? null,
            existingInsurerName: (activePlan.insurer_name as string | null) ?? null,
            parsedInsurerName: (planInsert.insurer_name as string | null) ?? null,
          })
        ) {
          // S292 Bug 2 — ASSEMBLY: the active "plan" is just the card's stub
          // (source manual/insurance_card, no plan name) and this document is
          // from the same carrier family — the card and the document are two
          // halves of ONE plan being built. Search-select already treats this
          // as assembly (set-active-canonical); the upload path now agrees
          // instead of asking the user to pick between her own card and her
          // own SBC. Merge into the stub — the identityTargetPlan path,
          // receipt and all — no prompt. `canonical_differs` never reaches
          // here (shouldAssembleStub refuses it), so a catalog-proven
          // different plan still asks.
          identityTargetPlan = {
            id: activePlan.id as string,
            plan_year: (activePlan.plan_year as number | null) ?? null,
          };
          identityMatchRecord = {
            mismatch: false,
            identity: {
              verdict: "same",
              reason: STUB_ASSEMBLY_REASON,
              evidence:
                "Your card and this document describe one plan — the document filled in the card's stub.",
              existingPlanId: activePlan.id as string,
              existingPlanName: (activePlan.plan_name as string | null) ?? null,
            },
          };
          console.log(
            `[plan-identity] stub-assembly override — resolver said ${identity.verdict}/${identity.reason} but the active plan is a ${activePlan.source} stub in the same insurer family; merging doc=${documentId} into ${activePlan.id}`,
          );
        } else {
          mismatchData = {
            mismatch: true,
            // `insurer_differs` is the only reason that is genuinely about the
            // carrier; every other non-same reason is a plan-level difference.
            type: identity.reason === "insurer_differs" ? "insurer" : "plan_name",
            existingInsurer: (activePlan.insurer_name as string | null) || "",
            parsedInsurer: (planInsert.insurer_name as string | null) || "",
            existingPlanName: (activePlan.plan_name as string | null) || undefined,
            parsedPlanName: (planInsert.plan_name as string | null) || undefined,
            // Carried into documents.insurer_mismatch so the upload UI can pick
            // between the "different plan" and "we couldn't tell" prompts, and
            // can quote the resolver's own sentence rather than inventing one.
            identity: {
              verdict: identity.verdict,
              reason: identity.reason,
              evidence: identity.evidence,
              existingPlanId: activePlan.id as string,
            },
          };
        }
      }
    }

    if (!identityDecided) {
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
      } else if (!planInsert.insurer_name && userProfile?.insurer) {
        // S90 Bug Y defensive guard: parser (incl. Bug X safety-net Haiku
        // fallback) failed to extract any insurer name AND the user has an
        // existing profile insurer. We cannot determine whether this upload
        // is the same plan or a different one. Fail-safe by treating as a
        // mismatch — the downstream merge step at L580 will create a new
        // is_active=false row instead of silently overwriting the user's
        // active plan's cost-share fields. Surfaces in UI as "insurer
        // mismatch" so the user can disambiguate.
        mismatchData = {
          mismatch: true,
          type: "insurer",
          existingInsurer: userProfile.insurer,
          parsedInsurer: "(parser could not extract)",
        };
      }
    }

    // ── Plan year rollover detection ─────────────────────────────────────────
    let yearRollover: { currentYear: number; newYear: number } | null = null;
    if (!mismatchData && planInsert.plan_year) {
      // S292 — when the resolver ran, reuse the row it actually compared against.
      // Re-querying here could return a DIFFERENT active row (multi-active), so
      // the rollover would be judged against a plan the identity decision never
      // saw. One decision, one row.
      const { data: refetchedActivePlanForYear } = identityTargetPlan
        ? { data: null }
        : await supabase
            .from("insurance_plans")
            .select("plan_year")
            .eq("user_id", doc.user_id)
            .eq("is_active", true)
            .single();
      const existingActivePlanForYear = identityTargetPlan
        ? { plan_year: identityTargetPlan.plan_year }
        : refetchedActivePlanForYear;

      if (existingActivePlanForYear?.plan_year
        && existingActivePlanForYear.plan_year !== planInsert.plan_year) {
        yearRollover = {
          currentYear: existingActivePlanForYear.plan_year,
          newYear: planInsert.plan_year,
        };
        console.log(`[process-plan] Year rollover: ${yearRollover.currentYear} → ${yearRollover.newYear}`);
      }
    }

    // seedMode (cold-start regen): no mismatch concept for the seed (it targets a known plan) — skip
    // the per-doc documents.insurer_mismatch churn write.
    if (mismatchData && !options?.seedMode) {
      console.log(`[process-plan] Mismatch (${mismatchData.type})`);
      await supabase.from("documents").update({ insurer_mismatch: mismatchData }).eq("id", documentId);
      planInsert.is_active = false;
      planInsert.activated_at = null; // S320 — the stamp mirrors is_active
    }

    // S292 — the match receipt. Written only when the identity resolver actually
    // ran and said "same", and only when nothing more urgent claims the surface:
    // a year rollover is a decision the user must make, so it outranks a receipt
    // about a merge that already happened.
    if (identityMatchRecord && !yearRollover && !options?.seedMode) {
      console.log(`[process-plan] Identity match — merged into ${identityMatchRecord.identity.existingPlanId}`);
      await supabase.from("documents").update({ insurer_mismatch: identityMatchRecord }).eq("id", documentId);
    }

    // seedMode (cold-start regen): skip the per-doc year-rollover documents churn write.
    if (yearRollover && !options?.seedMode) {
      // Store year rollover info alongside any mismatch data
      await supabase.from("documents").update({
        insurer_mismatch: { ...(mismatchData || {}), year_rollover: yearRollover },
      }).eq("id", documentId);
      planInsert.is_active = false; // Wait for user confirmation before activating new year plan
      planInsert.activated_at = null; // S320 — the stamp mirrors is_active
    }

    // If no mismatch and an active plan exists, MERGE services into it
    // (SBC + plan document are complementary sources for the same plan).
    // Comparison uploads SKIP merging — they're a separate plan the user
    // wants to evaluate, not an enrichment of their primary.
    let mergeIntoExistingPlan: string | null = null;
    if (!mismatchData && !yearRollover && !isComparisonUpload) {
      if (identityTargetPlan) {
        // S292 — the resolver said "same plan" ABOUT THIS ROW, so this is the
        // row we merge into. Re-querying was the structural bug: the mismatch
        // check read `profiles` and the merge target read `insurance_plans`, so
        // on a multi-active account we could clear a merge against one plan and
        // then write it into another.
        mergeIntoExistingPlan = identityTargetPlan.id;
        console.log(`[process-plan] Merging into identity-resolved plan: ${mergeIntoExistingPlan}`);
      } else {
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
    }

    // If merging, skip creating a new plan — use the existing one
    // If not merging (mismatch or no existing plan), create a new plan
    let targetPlanId: string;

    if (options?.seedMode && options.seedTargetPlanId) {
      // (c) seed write-path: target the doc's existing canonical-linked plan directly. The production
      // mismatch/active-merge/INSERT resolution keys on is_active + can't find an inactive seed plan
      // (it would orphan). is_active + canonical_plan_id preserved by omission below.
      targetPlanId = options.seedTargetPlanId;
      // S256: when the seed carries a plan-identity override, persist the regenerated EXTRACTED identity
      // (deductible/OOP in+out, plan_name/type/year + Pattern-P8 provenance) to the existing plan so the
      // canonical identity promotion reads it. §19-D clobber-guard: only write fields the override has a
      // NON-NULL value for (a parse-miss can't null-clobber a populated deductible). metal_level/is_aca
      // (derived, §16-D/§19-D) + is_active + canonical_plan_id are preserved by omission.
      if (options.planIdentityOverride) {
        const SEED_IDENTITY_COLS = [
          "in_deductible_individual", "in_deductible_family", "in_oop_max_individual", "in_oop_max_family",
          "out_deductible_individual", "out_deductible_family", "out_oop_max_individual", "out_oop_max_family",
          "plan_name", "plan_type", "plan_year",
        ] as const;
        const { data: existingPlan } = await supabase
          .from("insurance_plans").select("field_provenance").eq("id", targetPlanId).maybeSingle();
        const mergedProv: Record<string, unknown> = { ...((existingPlan?.field_provenance as Record<string, unknown>) ?? {}) };
        const idUpdate: Record<string, unknown> = {};
        for (const col of SEED_IDENTITY_COLS) {
          const v = (planInsert as Record<string, unknown>)[col];
          if (v == null) continue; // clobber-guard: a null/missing re-parse never overwrites a populated value
          idUpdate[col] = v;
          const entry = (planIdentityProvenance as Record<string, unknown> | null)?.[col];
          if (entry != null) mergedProv[col] = entry;
        }
        if (Object.keys(idUpdate).length > 0) {
          idUpdate.field_provenance = mergedProv;
          const { error: idErr } = await supabase.from("insurance_plans").update(idUpdate).eq("id", targetPlanId);
          if (idErr) throw new Error(`seedMode identity write (${targetPlanId}) failed: ${idErr.message}`);
        }
      }
    } else if (mergeIntoExistingPlan) {
      targetPlanId = mergeIntoExistingPlan;
      // Update the existing plan with any new metadata (deductibles, OOP, etc.)
      // Phase 3.2.1 — also propagate field_provenance from this upload's parse so
      // Pattern P-8 cite chain stays current. Plan_document path skips since
      // planIdentityProvenance is null there.
      //
      // S286 supplement-merge (Andrew-approved matrix; policy + fixture in
      // src/lib/plan/plan-merge.ts): every subsequent doc parse SUPPLEMENTS the
      // existing row — fill gaps, never erase, confirm matches (corroboration
      // recorded), and resolve conflicts per DOCUMENT (more complete parse wins,
      // tie → newest). Weak incumbents (manual / uncited values) always yield to
      // a cited parse (CF-25: docs are the authority; manual is provisional).
      const { data: mergeTargetRow } = await supabase
        .from("insurance_plans")
        .select("*")
        .eq("id", targetPlanId)
        .single();
      // Document data only: strip housekeeping + ACA (extractedAca keeps its own
      // only-write-when-extracted semantics per S74.6 D1) from the doc payload…
      const mergeDocFields: Record<string, unknown> = { ...planInsert };
      for (const k of [
        "user_id",
        "source",
        "source_document_id",
        "is_active",
        "verification_status",
        "field_provenance",
        ...Object.keys(acaForInsert),
      ]) {
        delete mergeDocFields[k];
      }
      // …and undo the create-branch profile fallbacks (703-704): a profile-typed
      // number is not "the document found it" — supplement merges carry parse
      // evidence only.
      if (parseResult.plan.in_deductible_individual == null) delete mergeDocFields.in_deductible_individual;
      if (parseResult.plan.in_oop_max_individual == null) delete mergeDocFields.in_oop_max_individual;
      const supplementMerge = applyDocSupplementMerge({
        base: {
          source: (isFullPlanDoc ? "plan_doc_upload" : "sbc_upload") as string,
          source_document_id: documentId,
          is_active: true,
          // S319 mig 231 — every is_active=true writer stamps the activation.
          activated_at: new Date().toISOString(),
          verification_status: "document_verified" as const,
          // S74.6 D1 — propagate ACA columns only when THIS parse extracted a
          // signal. When Haiku found nothing, preserve the plan's prior ACA value
          // (don't overwrite a previously-extracted basis with 'unknown' just
          // because this re-parse chunk lacked the phrase).
          ...(extractedAca ?? {}),
        },
        docFields: mergeDocFields,
        existingRow: (mergeTargetRow ?? {}) as Record<string, unknown>,
        existingProvenance:
          ((mergeTargetRow as Record<string, unknown> | null)?.field_provenance as Record<string, unknown> | null) ?? null,
        parseProvenance: planIdentityProvenance as Record<string, unknown> | null,
        documentId,
      });
      console.log(
        `[process-plan] supplement-merge (${targetPlanId}): ${JSON.stringify(supplementMerge.actions)}` +
          (supplementMerge.conflictWinner ? ` — conflicts → ${supplementMerge.conflictWinner}` : ""),
      );
      // Ensure profile points to this plan and back-populate plan info
      const profileUpdate: Record<string, unknown> = { active_insurance_plan_id: targetPlanId };
      if (planInsert.insurer_name) profileUpdate.insurer = planInsert.insurer_name;
      if (planInsert.plan_name) profileUpdate.plan_name = planInsert.plan_name;

      // ── S292 item 4C — merge receipt, captured BEFORE the write ─────────────
      // The escape hatch on the match receipt has to REVERT: at the 0.85 floor
      // the merge lands before the user sees the confirmation. Nothing in the
      // schema can reconstruct the prior state afterwards — the supplement-merge
      // overwrites each column AND its citation together, and coverage cells
      // upsert in place — so the pre-image is captured here or it is gone.
      //
      // Written BEFORE the merge on purpose: a receipt whose merge then fails is
      // harmless (reverting to values that were never changed is a no-op), while
      // a merge whose receipt fails to write is unrevertable.
      if (identityMatchRecord && !options?.seedMode) {
        try {
          const { data: cellsBeforeRows, error: cellsErr } = await supabase
            .from("plan_covered_services")
            .select("*")
            .eq("insurance_plan_id", targetPlanId);
          if (cellsErr) throw new Error(cellsErr.message);

          const rows = cellsBeforeRows ?? [];
          // No silent caps: past the ceiling we record that services can't be
          // unwound rather than snapshotting a partial set that would look
          // complete and revert only some of the plan.
          const servicesUnwindable = rows.length <= MAX_RECEIPT_CELLS;
          const priorProv =
            ((mergeTargetRow as Record<string, unknown> | null)?.field_provenance as
              | Record<string, unknown>
              | null) ?? null;
          const before = (mergeTargetRow ?? {}) as Record<string, unknown>;
          const planBefore: Record<string, unknown> = {};
          for (const col of Object.keys(supplementMerge.update)) planBefore[col] = before[col] ?? null;

          const { data: profBefore } = await supabase
            .from("profiles")
            .select("active_insurance_plan_id, insurer, plan_name")
            .eq("user_id", doc.user_id)
            .maybeSingle();

          const receipt: PlanMergeReceipt = {
            version: PLAN_MERGE_RECEIPT_VERSION,
            documentId,
            targetPlanId,
            mergedAt: new Date().toISOString(),
            plan: { before: planBefore, wrote: supplementMerge.update },
            provenanceBefore: priorProv,
            profile: profBefore
              ? { before: profBefore as Record<string, unknown>, wrote: profileUpdate }
              : null,
            cellsBefore: servicesUnwindable
              ? rows.map((r) => ({
                  key: {
                    service_id: String(r.service_id ?? ""),
                    place_of_service: String(r.place_of_service ?? "any"),
                    component: String(r.component ?? "global"),
                    plan_tier_label: String(r.plan_tier_label ?? "none"),
                  },
                  row: r as Record<string, unknown>,
                }))
              : [],
            servicesUnwindable,
          };

          const { data: docRow } = await supabase
            .from("documents").select("metadata").eq("id", documentId).maybeSingle();
          const meta = ((docRow?.metadata as Record<string, unknown> | null) ?? {});
          await supabase
            .from("documents")
            .update({ metadata: { ...meta, plan_merge_receipt: receipt } })
            .eq("id", documentId);
          console.log(
            `[process-plan] merge receipt captured (doc=${documentId} plan=${targetPlanId} cols=${Object.keys(supplementMerge.update).length} cells=${receipt.cellsBefore.length} servicesUnwindable=${servicesUnwindable})`,
          );
        } catch (err) {
          // Non-fatal: a missing receipt must not fail the upload. It DOES mean
          // this merge cannot be undone, so it is logged loudly rather than
          // swallowed — and the escape hatch hides itself when the receipt is
          // absent instead of offering an undo that would do nothing.
          console.error("[process-plan] merge receipt capture FAILED — this merge will not be unwindable:", err);
        }
      }

      await supabase.from("insurance_plans").update(supplementMerge.update).eq("id", targetPlanId);
      // seedMode (cold-start regen): never churn the admin's active-plan pointer ×N seed docs.
      if (!options?.seedMode) {
        await supabase.from("profiles").update(profileUpdate).eq("user_id", doc.user_id);
        // S320 — the merge just (re)activated this plan for the user: unlinked
        // claims adopt it. This branch was the /check SBC-upload gap's sibling
        // (activation without adoption); finalize pairs the claim-follow family
        // wherever the profile pointer moves. seedMode stays excluded — the
        // regen must never adopt the admin's claims onto seed plans.
        await finalizePlanActivation(supabase, doc.user_id as string, targetPlanId as string);
      }
    } else {
      // For comparison uploads: never deactivate the user's existing primary
      // plan. The new comparison row inserts with is_active=false (per planInsert
      // above), so coexistence is automatic.
      // S317 — captured inside the SAME guard that does the deactivation, so
      // the comparison / mismatch / seedMode exclusions hold for the repoint
      // too: those branches never deactivate, so nothing is ever stranded and
      // this list stays empty.
      let activeBeforeIds: string[] = [];
      if (!mismatchData && !isComparisonUpload && !options?.seedMode) {
        const { data: activeBeforeRows } = await supabase
          .from("insurance_plans")
          .select("id")
          .eq("user_id", doc.user_id)
          .eq("is_active", true);
        activeBeforeIds = (activeBeforeRows ?? []).map((p: { id: string }) => p.id);
        // Deactivate old plans (but don't delete — data stays for platform).
        // seedMode (cold-start regen): skip — don't deactivate the admin's other seed plans ×N docs.
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
      // seedMode (cold-start regen): also skip — don't churn the admin's active-plan pointer ×N docs.
      if (!mismatchData && !isComparisonUpload && !options?.seedMode) {
        // Back-populate profile with plan info from document
        const profileUpdate: Record<string, unknown> = { active_insurance_plan_id: newPlan.id };
        if (planInsert.insurer_name) profileUpdate.insurer = planInsert.insurer_name;
        if (planInsert.plan_name) profileUpdate.plan_name = planInsert.plan_name;
        await supabase.from("profiles").update(profileUpdate).eq("user_id", doc.user_id);
        // S320 — the pairing that closed the /check SBC-upload gap: this
        // inline activation adopted nothing, so every bill-before-plan claim
        // stayed unlinked (plan costs never flowed; corrections dead-ended).
        // finalize = adopt (S315) + follow-deactivated (S317), inseparable.
        await finalizePlanActivation(
          supabase,
          doc.user_id as string,
          newPlan.id as string,
          activeBeforeIds,
        );
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

    // (d) seedMode (cold-start regen): resolve the canonical from the plan's PRESERVED link (the
    // AUTHORITATIVE target) so the promotion (admin_override) can fire. The identity-driven match below is
    // then EXPLICITLY skipped for seedMode (see the seedMode branch in the canonical-match conditional).
    // S256: pre-identity-override the seed had empty insurer/plan_name → the match self-skipped; now the
    // seed carries a real identity, so it would re-match + could CREATE AN ORPHAN canonical — hence the
    // explicit skip.
    if (options?.seedMode && options.seedTargetPlanId) {
      const { data: seedPlan, error: seedErr } = await supabase
        .from("insurance_plans").select("canonical_plan_id").eq("id", options.seedTargetPlanId).maybeSingle();
      if (seedErr) throw new Error(`seedMode: read seedTargetPlanId failed: ${seedErr.message}`);
      if (!seedPlan) throw new Error(`seedMode: seedTargetPlanId ${options.seedTargetPlanId} not found`);
      if (!seedPlan.canonical_plan_id) {
        throw new Error(`seedMode: plan ${options.seedTargetPlanId} has null canonical_plan_id (harness should pre-filter)`);
      }
      canonicalPlanId = seedPlan.canonical_plan_id as string;
    }

    // Check feature flag — get user email for targeting
    const userForFlag = await getUserContextByPk(supabase, doc.user_id, "process-plan:canonical_plans");
    const canonicalEnabled = await isFeatureEnabled("canonical_plans", userForFlag?.email || undefined);

    if (!canonicalEnabled) {
      console.log("[canonical-plan] Feature flag disabled for this user, skipping");
    } else if (skipCanonical) {
      // Medium-confidence doc — held for admin review, don't touch canonical tables
    } else if (options?.seedMode) {
      // (d) seedMode (cold-start regen): canonicalPlanId is ALREADY resolved from the plan's preserved link
      // (934-942) — the authoritative target. Skip the identity-driven match entirely: post-S256 the seed
      // carries a real insurer/plan_name (identity override), so matchInsurerWithPlanFallback would
      // re-identify and could CREATE AN ORPHAN canonical + set canonicalNeedsConfirmation (silently
      // blocking the promotion at ~line 1495). The seed targets a KNOWN canonical; never re-identify/insert.
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
          // CF-63 RC-2 source-side coercion (S128): `||` treated $0 deductible
          // as falsy, converting to undefined before reaching createCanonicalPlan.
          // Now `??` preserves $0 through the call chain.
          deductible: planInsert.in_deductible_individual ?? undefined,
          oopMax: planInsert.in_oop_max_individual ?? undefined,
          // CF-63 RC-4 (S128): wire metalTier into canonical creation. Source
          // is parseResult.metalTier (legacy-adapter surfaces this from
          // SBCHaikuParseResult.planIdentity.metalTier — previously dropped).
          metalTier: parseResult.metalTier ?? undefined,
          // Ing-K Phase 1 (S129): document + insurance_plan context for
          // canonical_match_decisions telemetry. Lets admin group decisions
          // by upload to surface the "same SBC → multiple canonicals" bug.
          documentId,
          insurancePlanId: targetPlanId,
        });

        if (canonicalResult.needsConfirmation) {
          // Store pending match for user confirmation — don't link yet
          canonicalNeedsConfirmation = true;
          await supabase.from("documents").update({
            insurer_mismatch: {
              // S292 — carry the identity record through. This spread rebuilds
              // the column from scratch, so without it a document that merged
              // cleanly AND drew a pending canonical match would lose its merge
              // receipt: the user would never learn which plan absorbed it, and
              // the unwind would have nothing to act on.
              ...(mismatchData || identityMatchRecord || {}),
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
          // mig 218 — write the link WITH the confidence that produced it. This
          // number was already computed here and thrown away; without it
          // plan-identity.ts treats the link as unscored and can never decide
          // "same plan" / "different plan" on it.
          await linkPlanToCanonical(
            supabase,
            targetPlanId,
            canonicalPlanId,
            canonicalResult.confidence,
          );

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

    // ── Cost-F (S129): unified parse_cost_events ledger write ──────────────
    // Records base-parse Haiku cost into parse_cost_events with canonical
    // attribution (when canonical-match resolved a canonical_plan_id above).
    // Powers /admin/cost-per-canonical + daily cron alerts. Non-fatal.
    //
    // SBC path: haikuResult.costUsd (votedParseSBC output)
    // plan_doc Haiku ON: planDocHaikuResult.costUsd
    // plan_doc Haiku OFF (regex fallback): cost=0; still recorded for activity
    //   attribution even though no Haiku spend occurred.
    // seedMode (cold-start regen): skip the parse_cost_events ledger ×N seed docs (all 3 branches).
    if (!options?.seedMode && haikuResult) {
      await recordCostEvent(supabase, {
        canonicalPlanId: canonicalPlanId ?? null,
        insurancePlanId: targetPlanId,
        documentId,
        userId: doc.user_id,
        parserKind: "sbc_base",
        costSource: "user_upload",
        costUsd: haikuResult.costUsd,
        haikuTokensInput: haikuResult.haikuTokensInput,
        haikuTokensOutput: haikuResult.haikuTokensOutput,
        haikuCacheReadTokens: haikuResult.haikuCacheReadTokens,
        haikuCacheCreateTokens: haikuResult.haikuCacheCreateTokens,
        metadata: {
          voting_triggered: haikuResult.votingMetadata.triggered,
          successful_attempts: haikuResult.votingMetadata.successfulAttempts,
          dispatched_sections: haikuResult.dispatchedSections,
        },
      });
    } else if (!options?.seedMode && planDocHaikuResult) {
      await recordCostEvent(supabase, {
        canonicalPlanId: canonicalPlanId ?? null,
        insurancePlanId: targetPlanId,
        documentId,
        userId: doc.user_id,
        parserKind: "plan_doc_base",
        costSource: "user_upload",
        costUsd: planDocHaikuResult.costUsd,
        metadata: {
          haiku_used: true,
        },
      });
    } else if (!options?.seedMode && isFullPlanDoc) {
      // Regex fallback path — no Haiku spend, but record event for activity
      await recordCostEvent(supabase, {
        canonicalPlanId: canonicalPlanId ?? null,
        insurancePlanId: targetPlanId,
        documentId,
        userId: doc.user_id,
        parserKind: "plan_doc_base",
        costSource: "user_upload",
        costUsd: 0,
        metadata: {
          haiku_used: false,
        },
      });
    }

    // ── Ing-H (CF-44, S129): persist column_wrap_decision to documents.metadata ─
    // For admin observability + heuristic threshold calibration. Only SBC path
    // populates columnWrapDecision (plan_doc self-check is OFF per S77; heuristic
    // N/A there). Uses read-spread-write to avoid overwriting other metadata
    // keys (safer than process-eoc's overwrite pattern; future cleanup should
    // backport this safer write to process-eoc).
    if (haikuResult?.columnWrapDecision) {
      try {
        const { data: docMeta } = await supabase
          .from("documents")
          .select("metadata")
          .eq("id", documentId)
          .single();
        const existingMetadata =
          (docMeta?.metadata as Record<string, unknown> | null) ?? {};
        await supabase
          .from("documents")
          .update({
            metadata: {
              ...existingMetadata,
              column_wrap_decision: haikuResult.columnWrapDecision,
            },
          })
          .eq("id", documentId);
      } catch (err) {
        console.warn("[process-plan] column_wrap_decision metadata write (non-fatal):", err);
      }
    }

    // ── Service catalog + plan_covered_services ─────────────────────────────
    // S94 B1 Stage 3 — Canonical authority gate. service_catalog is now a curated
    // 68-slug canonical vocabulary (mig 103 + reset script). Auto-create of new
    // slugs is REMOVED to prevent re-sprawl. Parser emissions are partitioned:
    //   - canonical slug (in service_catalog, proposal_state='canonical') → accept
    //   - `proposed_*` slug (Haiku unknown-service convention) → enqueue to
    //     service_catalog_admin_review_queue (Pattern P-9); admin promotes via
    //     /admin/review-queue
    //   - bare unknown slug → log warning + reject (parser violation per S94 LOCK)
    let servicesCreated = 0;
    if (parseResult.services.length > 0) {
      const { data: canonicalCatalogRows } = await supabase
        .from("service_catalog")
        .select("slug")
        .eq("proposal_state", "canonical")
        .eq("canonical_for_concept", true);
      const canonicalSlugSet = new Set<string>(
        (canonicalCatalogRows ?? []).map((r: { slug: string }) => r.slug),
      );

      const acceptedServices: typeof parseResult.services = [];
      let proposedEnqueuedCount = 0;
      let bareUnknownRejectedCount = 0;
      for (const svc of parseResult.services) {
        const slug = svc.serviceSlug;
        if (canonicalSlugSet.has(slug)) {
          acceptedServices.push(svc);
          continue;
        }
        if (slug.startsWith("proposed_")) {
          try {
            // SBCParsedService (legacy) lacks patternP8; PlanDocService (Haiku-first
            // plan_doc) carries it. Both flow through parseResult.services so we
            // access defensively via unknown-cast.
            const patternP8 = (svc as { patternP8?: {
              source_excerpt?: string;
              source_excerpt_verified?: "verified" | "not_found" | "ocr_unverifiable";
              source_excerpt_extraction_method?: "pdftotext" | "native_pdf_text" | "ocr";
              source_section_hint?: string;
              source_section_verified?: boolean;
            } }).patternP8;
            // seedMode (cold-start regen): skip the review-queue enqueue ×N seed docs.
            if (!options?.seedMode) await enqueueUnknownServiceSlug(supabase, {
              sourceDocId: documentId,
              proposedByUserId: slugEnqueueContext.proposedByUserId,
              parserSource: isFullPlanDoc ? "plan_document" : "sbc",
              proposedServiceSlug: slug,
              proposedServiceLabel: slug.replace(/^proposed_/, "").replace(/_/g, " "),
              proposedCategory: null,
              sourceExcerpt: patternP8?.source_excerpt ?? "",
              sourceExcerptVerified: patternP8?.source_excerpt_verified ?? "not_found",
              sourceExcerptExtractionMethod: patternP8?.source_excerpt_extraction_method ?? "pdftotext",
              sourceSectionHint: patternP8?.source_section_hint ?? "services_cost_sharing",
              sourceSectionVerified: patternP8?.source_section_verified ?? false,
              contextExtract: null,
            });
            proposedEnqueuedCount++;
          } catch (e) {
            console.warn(
              `[process-plan] enqueue proposed slug failed: ${slug}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
          continue;
        }
        console.warn(
          `[process-plan] S94-canonical-gate: rejecting bare unknown slug "${slug}" (not canonical, not proposed_*). Source: ${
            isFullPlanDoc ? "plan_document" : "sbc"
          }`,
        );
        bareUnknownRejectedCount++;
      }
      parseResult.services = acceptedServices;
      console.log(
        `[process-plan] S94 canonical gate: ${acceptedServices.length} canonical accepted, ${proposedEnqueuedCount} proposed_* enqueued, ${bareUnknownRejectedCount} bare unknowns rejected (of ${
          acceptedServices.length + proposedEnqueuedCount + bareUnknownRejectedCount
        } parser emissions)`,
      );

      // Skip downstream catalog writes if every emission was rejected/enqueued.
      if (parseResult.services.length === 0) {
        servicesCreated = 0;
        // fall through to plan_covered_services path; it'll see 0 services and
        // skip cleanly. UX layer's "Half the picture's here" / "stumping us"
        // copy handles the user-facing case via processed/error status.
      }

      const allSlugs = [...new Set(parseResult.services.map((s) => s.serviceSlug))];
      const BATCH_SIZE = 50;
      const slugToId = new Map<string, string>();

      for (let i = 0; i < allSlugs.length; i += BATCH_SIZE) {
        const batch = allSlugs.slice(i, i + BATCH_SIZE);
        const { data: existing } = await supabase.from("service_catalog").select("id, slug").in("slug", batch);
        for (const s of existing || []) slugToId.set(s.slug, s.id);
      }

      // Missing slugs at this point would indicate a race (canonical row deleted
      // between gate-read and lookup). Log + skip rather than auto-create.
      const missingSlugs = allSlugs.filter((s) => !slugToId.has(s));
      if (missingSlugs.length > 0) {
        console.error(
          `[process-plan] S94-canonical-gate: ${missingSlugs.length} slugs passed gate but missing from service_catalog (race or stale cache): ${missingSlugs.join(", ")}`,
        );
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

      // Cell identity = (slug, place_of_service, component, plan_tier_label) — matches the storage UNIQUE key
      // (canonical_plan_services mig 147/169/194 + plan_covered_services mig 157/195). Keying dedup + provenance
      // maps on the FULL tuple (not just slug|pos) stops component-distinct rows (ER "Facility" coinsurance vs
      // "Physician Services" copay) AND bucket-distinct drug rows (generic Preferred vs Non-Preferred; Tier 1 vs
      // Tier 2; Condition-Care vs All-Other) from silently collapsing before write. Additive: only splits
      // previously-merged variants, never merges.
      // ensureTier (mig 194, S258): derive the plan-local drug cost-share BUCKET from the verbatim label once
      // per service (deterministic + shared claims/plan-doc); 'none' when not a bucketed drug line. Caches on
      // the object so the dedup key, the provenance-map keys, and the pcs payload all agree.
      const ensureTier = (s: SBCParsedService): string => {
        if (s.planTierLabel == null) s.planTierLabel = derivePlanTierLabel(s.rawLabel ?? "").planTierLabel ?? "none";
        return s.planTierLabel;
      };
      const cellKey = (
        slug: string, pos: string | null | undefined, component: string | null | undefined, planTierLabel: string,
      ) => `${slug}|${pos || "any"}|${coerceComponent(component)}|${planTierLabel}`;
      // Deduplicate: keep highest-confidence per (slug, place_of_service, component, plan_tier_label)
      const deduped = new Map<string, SBCParsedService>();
      for (const s of parseResult.services) {
        if (!slugToId.has(s.serviceSlug)) continue;
        const key = cellKey(s.serviceSlug, s.placeOfService, s.component, ensureTier(s));
        const existing = deduped.get(key);
        if (!existing || s.confidence > existing.confidence) deduped.set(key, s);
      }

      const confident = [...deduped.values()].filter(s => s.confidence >= 0.5);

      // Phase 3.2.1 — when haikuResult is available, build a parallel map of
      // SBCHaikuService rows keyed by (slug, place_of_service) so we can attach
      // Pattern P-8 field_provenance JSONB to each persisted plan_covered_services
      // row.
      // S94 B1 — also build the equivalent map for the plan_doc Haiku-first parser
      // path. Pre-S94 the plan_doc path left field_provenance={} → cite-grade 0%
      // in PROD since flag flipped 2026-05-15. Now both maps consulted at insert
      // time so whichever parser ran writes provenance.
      const haikuServiceByKey = new Map<string, SBCHaikuService>();
      if (haikuResult) {
        for (const hs of [...haikuResult.services, ...haikuResult.otherCoveredServices]) {
          const key = cellKey(hs.serviceSlug, hs.placeOfService, hs.component, ensureTier(hs));
          const existing = haikuServiceByKey.get(key);
          if (!existing || hs.confidence > existing.confidence) haikuServiceByKey.set(key, hs);
        }
      }
      const planDocServiceByKey = new Map<string, import("@/lib/plan_doc/types").PlanDocService>();
      if (planDocHaikuResult) {
        for (const ps of planDocHaikuResult.services) {
          const key = cellKey(ps.serviceSlug, ps.placeOfService, ps.component, ensureTier(ps));
          const existing = planDocServiceByKey.get(key);
          if (!existing || ps.confidence > existing.confidence) planDocServiceByKey.set(key, ps);
        }
      }

      // S94 B1 — coerce Haiku placeOfService output to plan_covered_services
      // place_of_service CHECK constraint (mig 009 line 196). Plan_doc Haiku
      // emits free-form labels like "office" / "facility"; SBC parser hardcodes
      // "any". CHECK rejects anything not in the allowed list, dropping all
      // service rows silently. Coerce here.
      const VALID_POS = new Set([
        "pcp_office", "specialist_office", "outpatient_facility", "inpatient_facility",
        "independent_facility", "home", "virtual", "retail_pharmacy",
        "home_delivery_pharmacy", "designated_pharmacy", "any",
      ]);
      const coercePOS = (raw: string | null | undefined): string => {
        const s = (raw ?? "").toLowerCase().trim();
        if (VALID_POS.has(s)) return s;
        // Common Haiku-emit alternatives → nearest canonical.
        if (s === "office" || s === "primary_care" || s === "primary_care_office") return "pcp_office";
        if (s === "specialist" || s === "specialist_visit") return "specialist_office";
        if (s === "facility" || s === "outpatient") return "outpatient_facility";
        if (s === "inpatient" || s === "hospital") return "inpatient_facility";
        if (s === "telehealth" || s === "video" || s === "virtual_visit") return "virtual";
        if (s === "pharmacy" || s === "retail") return "retail_pharmacy";
        // Unknown / empty / non-string → "any" (preserves the row; slug carries identity).
        return "any";
      };

      const serviceInserts = confident.map((s) => {
        const pos = coercePOS(s.placeOfService);
        const haikuService = haikuServiceByKey.get(cellKey(s.serviceSlug, coercePOS(s.placeOfService), s.component, ensureTier(s)))
          ?? haikuServiceByKey.get(cellKey(s.serviceSlug, s.placeOfService, s.component, ensureTier(s)));
        const planDocService = planDocServiceByKey.get(cellKey(s.serviceSlug, coercePOS(s.placeOfService), s.component, ensureTier(s)))
          ?? planDocServiceByKey.get(cellKey(s.serviceSlug, s.placeOfService, s.component, ensureTier(s)));
        return {
          insurance_plan_id: targetPlanId,
          service_id: slugToId.get(s.serviceSlug)!,
          concept_id: conceptIdMap.get(s.serviceSlug) || null,
          place_of_service: pos,
          component: coerceComponent(s.component),
          plan_tier_label: s.planTierLabel ?? "none",
          in_copay: s.inCopay, in_coinsurance: normalizeCoinsuranceForStorage(s.inCoinsurance),
          in_deductible_applies: s.inDeductibleApplies, in_copay_waiver_condition: s.inCopayWaiverCondition,
          in_cost_description: s.inCostDescription,
          out_copay: s.outCopay, out_coinsurance: normalizeCoinsuranceForStorage(s.outCoinsurance),
          out_deductible_applies: s.outDeductibleApplies, out_cost_description: s.outCostDescription,
          oon_paid_at_in_network: s.oonPaidAtInNetwork,
          annual_limit: s.annualLimit, annual_limit_value: s.annualLimitValue,
          prior_auth_required: s.priorAuthRequired, penalty_no_precert: s.penaltyNoPrecert,
          // coverage_dims_v1 (mig 186): per-service referral (code-derived) + visit/day-count cap.
          // Sourced from the parser object (same as the field_provenance below), not the routed `s`.
          requires_referral: (haikuService ?? planDocService)?.referralRequired ?? null,
          visit_limit: (haikuService ?? planDocService)?.visitLimit ?? null,
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
          // S94 B1: plan_doc path now writes provenance via buildPlanDocServiceProvenance.
          ...(haikuService
            ? {
                field_provenance: buildPlanCoveredServiceProvenance(
                  haikuService,
                  "doc_extraction",
                  haikuResult?.dispatchedSections,
                  // A3: identity stamp rides `s` (the routed legacy object); thread it so the
                  // cell's provenance records a synonym-cache OVERRIDE. undefined on direct/rename.
                  s.identityResolution?.source,
                ),
              }
            : planDocService
              ? {
                  field_provenance: buildPlanDocServiceProvenance(
                    planDocService,
                    "doc_extraction",
                    planDocHaikuResult?.dispatchedSections,
                    s.identityResolution?.source,
                  ),
                }
              : {}),
        };
      });

      if (serviceInserts.length > 0) {
        const { error: svcError } = await applyPlanCoverageCell(supabase, serviceInserts);
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
            // how_to_access is a service-level instruction stored in coverage_rules on the cell
            // rows; the reader (/api/plan/analyze) reads it off whichever cell it renders. Stamp
            // every cell uniformly — this also fixes the post-mig-157 multi-row .maybeSingle() throw.
            await mergeServiceCoverageRules(supabase, targetPlanId, serviceId, {
              how_to_access: svc.howToAccess,
            });
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
          // S256: seedMode promotes the regenerated EXTRACTED plan-identity (incl. OON via the A-option
          // list) — metal_level EXCLUDED (derived, §16-D/§19-D). Per-service coverage promotes separately
          // via expandPerServiceCandidates (helper-internal). Identity values were just persisted to
          // seedTargetPlanId above; a null identity field carries no value → no-op (clobber-guard holds
          // end-to-end). PROD (non-seed) passes the SBC identity + per-service candidates.
          const candidates = options?.seedMode
            ? PHASE_4_0_6_PLAN_IDENTITY_FIELDS_SBC
                .filter((f) => f !== "metal_level")
                .map((fieldName) => ({ serviceSlug: null, fieldName }))
            : derivePromotionCandidatesFromHaikuResult(haikuResult);
          const result = await commitUploadAndEvaluateCorroboration(supabase, {
            canonicalPlanId: canonicalPlanId!,
            actorUserId: userForFlagCheck?.id ?? doc.user_id,
            fireSource: "process-plan",
            candidates,
            documentId: doc.id,
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
    // seedMode (cold-start regen): skip consumer-side inheritance — the seed is a PRODUCER of canonical
    // coverage; inheriting canonical→user plan would pollute the seed plan's provenance (§19-C) + isn't
    // re-run-safe. (No-op anyway for single-source clean-set canonicals.)
    if (canonicalPlanId && !canonicalNeedsConfirmation && !canonicalIsNew && !options?.seedMode) {
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
          .select("service_slug, place_of_service, component, in_copay, in_coinsurance, in_deductible_applies, covered, prior_auth_required, out_copay, out_coinsurance, out_deductible_applies, annual_limit, requires_referral, visit_limit, coverage_rules, confidence, field_provenance")
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
                const { error: inhErr } = await applyPlanCoverageCell(supabase, {
                  insurance_plan_id: targetPlanId,
                  service_id: svc.id,
                  // mig 186 (S241): inherit the REAL cell + ALL dims (lossless §16-C) — not a copay-only
                  // 'any'/'global' subset — so a selected/inherited canonical plan is upload-equivalent
                  // (claims/benefits/disputes-ready), and multi-cell services no longer collapse.
                  place_of_service: cs.place_of_service ?? "any",
                  component: cs.component ?? "global",
                  in_copay: cs.in_copay,
                  in_coinsurance: normalizeCoinsuranceForStorage(cs.in_coinsurance),
                  in_deductible_applies: cs.in_deductible_applies,
                  covered: cs.covered,
                  prior_auth_required: cs.prior_auth_required,
                  out_copay: cs.out_copay ?? null,
                  out_coinsurance: normalizeCoinsuranceForStorage(cs.out_coinsurance),
                  out_deductible_applies: cs.out_deductible_applies ?? null,
                  annual_limit_value: cs.annual_limit ?? null,
                  requires_referral: cs.requires_referral ?? null,
                  visit_limit: cs.visit_limit ?? null,
                  coverage_rules: cs.coverage_rules ?? {},
                  confidence: Math.min(cs.confidence, 0.8), // Inherited data slightly lower confidence
                  source: "canonical_inherited" as const,
                  // Phase 3.2.1 — preserve Pattern P-8 cite chain across inheritance.
                  // canonical_plan_services row's field_provenance traces back to the
                  // original SBC user's source_excerpt; that's still the citable evidence
                  // for this user's plan. Defaults to {} when canonical row predates
                  // Phase 3.2.1 (legacy seed without field_provenance).
                  field_provenance: cs.field_provenance ?? {},
                });
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
        // Get file hash + TRUE doc type + upload time from the document record.
        // classified_type is the persisted classifier verdict (sbc/eoc/plan_document),
        // NOT the unified-parser-coerced 'plan_document' classification arg — required
        // for correct per-doc-type promotion state (Ing-D.0a).
        const { data: docForHash, error: docForHashError } = await supabase
          .from("documents")
          .select("file_hash, classified_type, created_at, classification_confidence, file_size, cf40_forced_reparse_reason")
          .eq("id", documentId)
          .single();
        if (!docForHash) {
          // G7 (S164): a failed docForHash silently nulls parseEventContext (it is
          // gated on docForHash?.classified_type) → the CF-40 v4 recorder never
          // fires — the EXACT S163 #160 defect that hid for the whole pre-S163
          // history. Make it loud AND queryable (a bare console.warn is precisely
          // how it stayed silent). Non-fatal; read-spread-write so we never clobber
          // existing metadata.
          console.warn(
            `[cf40-v4] recorder: docForHash query returned null for documentId=${documentId}` +
              (docForHashError ? ` (error: ${docForHashError.message})` : "") +
              ` — parseEventContext will be undefined; recorder will NOT fire.`,
          );
          const { data: curMetaRow } = await supabase
            .from("documents")
            .select("metadata")
            .eq("id", documentId)
            .maybeSingle();
          await supabase
            .from("documents")
            .update({
              metadata: {
                ...((curMetaRow?.metadata as Record<string, unknown> | null) ?? {}),
                cf40_dochash_resolve_failed: true,
              },
            })
            .eq("id", documentId);
        }

        // Uploader trust signals for the CF-40 v4 Layer 2/3 recorder. doc.user_id =
        // documents.user_id = the users PK (NOT firebase_uid; the upload route writes
        // user.id). Resolve by id. (S163 fix — the prior .eq("firebase_uid", …) never
        // matched a UUID → uploaderUser null → email undefined → the v4 flag read OFF +
        // trust defaulted to unverified, silently disabling the recorder.)
        const { data: uploaderUser } = await supabase
          .from("users")
          .select("is_admin, email_verified, phone_verified, email")
          .eq("id", doc.user_id)
          .maybeSingle();
        if (!uploaderUser) {
          console.warn(
            `[cf40-v4] recorder: uploader lookup failed for users.id=${doc.user_id} — trust defaults to unverified + v4 flag may read OFF (S163)`,
          );
        }

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

        // CF-40 v4 Layer 1 (Ing-D.0b) — self-check pass rate = fraction of
        // plan-identity fields carrying a verified Pattern P-8 source excerpt
        // (§2.1 "fraction of extracted fields verified against source text").
        // null when this parse path produced no P-8 verification (regex / no
        // Haiku) → the Layer 1 self-check gate is inapplicable.
        const p8ProvEntries = planIdentityProvenance
          ? Object.values(planIdentityProvenance).filter(
              (e) => e.source_excerpt_verified !== undefined,
            )
          : [];
        const selfCheckPassRate =
          p8ProvEntries.length > 0
            ? p8ProvEntries.filter((e) => e.source_excerpt_verified === "verified").length /
              p8ProvEntries.length
            : null;

        await recordExtractionResult(
          supabase,
          documentId,
          canonicalPlanId,
          doc.user_id,
          docForHash?.file_hash || null,
          extractedSlugs,
          haikuPlanIdentityValues,
          docForHash?.classified_type
            ? {
                docType: docForHash.classified_type as ClassifiedDocType,
                uploadedAt: docForHash.created_at
                  ? new Date(docForHash.created_at as string)
                  : new Date(),
                uploaderIsAdmin: uploaderUser?.is_admin === true,
                uploaderEmailVerified: uploaderUser?.email_verified === true,
                uploaderPhoneVerified: uploaderUser?.phone_verified === true,
                uploaderEmail: (uploaderUser?.email as string | undefined) ?? undefined,
                // CF-40 v4 Layer 1 contribution-gate inputs (Ing-D.0b).
                selfCheckPassRate,
                // OCR confidence is not plumbed to this layer (and is N/A for the
                // native-text pdftotext path); gate inapplicable until wired from
                // the OCR dispatcher (tracked follow-up).
                ocrConfidence: null,
                classificationConfidence:
                  (docForHash.classification_confidence as number | null) ?? null,
                fileSizeBytes: (docForHash.file_size as number | null) ?? 0,
                // plan_year lives on insurance_plans (planInsert), NOT documents. The
                // prior docForHash.plan_year selected a non-existent column → the whole
                // docForHash query failed → docForHash null → parseEventContext undefined
                // → recordParseEventV4 was never called (S163 root cause of
                // cf40_layer1_passed always null; the recorder had never fired in PROD).
                documentPlanYear: (planInsert.plan_year as number | null) ?? null,
                // No platform ban mechanism exists yet (no users.is_banned column);
                // wire a real signal when bans are introduced (tracked follow-up).
                uploaderIsBanned: false,
                // CF-40 v4 Layer 4 (Ing-D.0c-ii) — the forced-reparse reason
                // persisted at smart-skip decide-time (mig 141). Drives
                // verification-mode open/resolve. null = not a forced re-parse.
                forcedReparseReason:
                  (docForHash.cf40_forced_reparse_reason as ForcedReparseReason | null) ?? null,
              }
            : undefined,
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
    //
    // S92 Stage 6 (Pattern P-Q Parse Quality Flywheel): persist parse_quality_*
    // columns from the layout-aware Stage A label + parse-result composite
    // score. Drives the S93 admin tuning UI's failure-cluster queue. Only
    // populated when planDocHaikuResult is available (plan-doc parse path);
    // legacy regex / claude-extractor paths leave NULL.
    const parseQualityFields: Record<string, unknown> = {};
    if (planDocHaikuResult) {
      const layoutWarning = planDocHaikuResult.parseWarnings.find((w) => w.startsWith("layout_detected:"));
      const detectedLayout = (layoutWarning?.split(":")[1] ?? "unknown") as
        | "federal_sbc_8page"
        | "federal_sbc_csr_variant"
        | "full_eoc_narrative"
        | "employer_plan_booklet"
        | "plan_cert_summary"
        | "unknown";
      try {
        const { computeParseQuality } = await import("@/lib/plan_doc/parse-quality");
        const quality = computeParseQuality(planDocHaikuResult, detectedLayout);
        parseQualityFields.parse_quality_score = quality.score;
        parseQualityFields.parse_quality_layout = quality.layout;
        parseQualityFields.parse_quality_failure_mode = quality.failureMode;
        parseQualityFields.parse_quality_signature = quality.signature;
      } catch (err) {
        console.error("[process-plan] parse-quality compute (non-fatal):", err);
      }
    }
    await supabase.from("documents").update({
      status: "processed",
      linked_insurance_plan_id: targetPlanId,
      processing_step: null,
      processing_extracted_services: null,
      ...parseQualityFields,
    }).eq("id", documentId);

    // S78 — async ingestion: fire parse-complete email for large plan_doc/SBC.
    // Helper internally gates on pageCount > 30 + Resend idempotency key prevents
    // double-sends on QStash retry. Fail-soft.
    // seedMode (cold-start regen): never send the parse-complete email ×N seed docs.
    if (!options?.seedMode) {
      try {
        const { sendParseCompleteEmail } = await import("@/lib/email/onboarding-emails");
        await sendParseCompleteEmail(supabase, documentId);
      } catch (err) {
        console.error("[process-plan] parse-complete email (non-fatal):", err);
      }
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

/**
 * S92 Stage 2 — no-dead-end fallback. Three outcomes after parse:
 *   - 'partial_success' — plan-identity extracted but services=0. Set
 *     status='processed' so user sees a `/plan` rendering with the basics
 *     + a "Half the picture's here" CTA to re-upload. Admin still notified
 *     for data-quality monitoring (preserves S2 skeptical-mitigation).
 *   - 'genuine_failure' — neither plan-identity nor services recovered.
 *     Set status='error' so user sees the "This one's stumping us" copy
 *     with a retry CTA. Admin notified.
 *
 * The legacy `pending_review` status becomes admin-back-office-only — used
 * by the S90 PR #73 asymmetric-trust LOWER-MED branch + truly unrecognizable
 * docs. Never surfaced as the primary user UX from this function.
 */
type NoDeadEndOutcome = "partial_success" | "genuine_failure";

async function notifyAndFlagForReview(
  supabase: SupabaseClient,
  documentId: string,
  classification: { classifiedType: string; confidence: number },
  doc: { id: string; user_id: string; file_name: string },
  reason?: string,
  outcome: NoDeadEndOutcome = "genuine_failure",
) {
  try {
    const { notifyAdminForReview } = await import("@/lib/notifications");
    const { data: profile } = await supabase.from("profiles").select("email").eq("user_id", doc.user_id).single();
    await notifyAdminForReview(documentId, classification.classifiedType, classification.confidence, doc.file_name, profile?.email || "unknown");
  } catch { /* non-critical */ }

  if (outcome === "partial_success") {
    await supabase.from("documents").update({
      status: "processed",
      processing_step: "partial_no_services",
      processing_error: reason || "Plan-identity extracted but 0 services returned",
    }).eq("id", documentId);
  } else {
    await supabase.from("documents").update({
      status: "error",
      processing_step: "extraction_failed",
      processing_error: reason || "Haiku extraction failed or returned no services",
    }).eq("id", documentId);
  }
}
