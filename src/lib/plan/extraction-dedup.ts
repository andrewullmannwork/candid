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
import { parseHaikuJSON } from "@/lib/parser/safe-json";
import { applyPlanCoverageCell } from "@/lib/plan/coverage-targeting";
import { canonicalLinkFields } from "@/lib/plan/canonical-match";
// matchInsurerCatalog import removed (CF-40 v2 — Path B semantic-match smart-skip eliminated).
import type { ProcessPlanResult } from "@/lib/plan/process-plan";
import { extractImportantQuestions } from "@/lib/sbc/haiku-prompts/important-questions";
import { verifySBCSourceExcerpts } from "@/lib/sbc/verify-source-excerpts";
import { normalizeCoinsuranceForStorage } from "@/lib/billing/coinsurance";
import {
  buildSBCPlanIdentityProvenance,
  buildCanonicalInheritedProvenance,
} from "@/lib/parser/provenance-builders";
import type { FieldProvenanceEntry } from "@/lib/parser/field-categories";
import type { SBCPlanIdentity } from "@/lib/sbc/types";
import type { ClassifiedDocType } from "@/lib/classifier";
import {
  evaluateSmartSkipEligibility,
  getScaleTier,
  loadCF40V4Config,
  resolveTrustTier,
  type ForcedReparseInput,
  type ForcedReparseReason,
  type ValidityGateInput,
} from "@/lib/parser/cf40-v4";
import { toPlanDocType, type PlanDocType } from "@/lib/parser/doctype-expected-counts";
import { finalizePlanActivation } from "@/lib/claims/claim-plan-link";

// ── CF-40 v4 (S73.5 D1) — Plan-document-only smart-skip whitelist ─────────────
//
// Smart-skip is structurally restricted to plan documents (SBC, EOC, plan_doc).
// Bills, EOBs, insurance cards, and "other" docs MUST always extract — they
// carry per-transaction or per-card data that cannot be inherited from a
// canonical plan. Today's call site at /api/documents/upload already gates on
// classifiedType ∈ {"sbc", "plan_document"}, but this guard inside the function
// makes the invariant structural rather than implicit. See [[Candid_10k]] §3.1
// #6 + [[Candid_Parse_Patterns]] Pattern P-8 + [[Candid_Data_Patterns]] Pattern
// 1 #16.
//
// `education_doc` is intentionally NOT on this whitelist — Phase 2 per Subplan
// §2.4(c). Add when education_doc is added to the doc_type CHECK constraint.
export const PLAN_DOCUMENT_TYPES: readonly ClassifiedDocType[] = [
  "sbc",
  "plan_document",
  "eoc",
] as const;

export function isPlanDocumentType(docType: string | null | undefined): boolean {
  if (!docType) return false;
  return (PLAN_DOCUMENT_TYPES as readonly string[]).includes(docType);
}

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
  /**
   * mig 218 — the confidence of the link we are INHERITING, carried so the
   * smart-skip write can record the pair honestly.
   *
   * Smart-skip identifies a canonical by tracing a byte-identical document to a
   * plan already linked to it. The new link is therefore exactly as sound as the
   * one it copies, so we propagate that number instead of minting a fresh one —
   * a made-up 0.95 here would let a canonical originally created single-source
   * (0.5, uncorroborated) start deciding plan identity on the next upload.
   * `null`/absent stays UNKNOWN, which is the honest reading for a pre-mig-218
   * link that never recorded its own confidence.
   */
  canonicalMatchConfidence?: number | null;
  reason: string;
  /**
   * Ing-D.0c-ii — the structured Layer-5 forced-reparse reason when extraction
   * proceeds BECAUSE a stable+promoted canonical was force-re-parsed. NULL on a
   * skip, or an extract blocked before Layer 5. The caller (runSmartSkipCheck)
   * persists it to documents.cf40_forced_reparse_reason so the later
   * record-step (recordParseEventV4) can drive verification-mode open/resolve.
   */
  forcedReparseReason?: ForcedReparseReason | null;
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

/**
 * S292 — identity-extraction input window (measured, not argued).
 *
 * The historical window was slice(0, 2000) with a cost rationale. Both parts
 * were wrong: (a) cost — the services pass (claude-extractor.ts) already sends
 * up to 100,000 chars of the same OCR, so the identity call's window saved
 * ~nothing; (b) position — federal-layout SBCs OPEN with a ~3,100-char
 * standardized glossary/boilerplate block, pushing the real header ("Coverage
 * Period: MM/DD/YYYY … Plan Type: …") past offset 2,000. On the 27-doc DEV
 * corpus, 7/27 documents (2 carriers) had their header beyond 2,000 chars and
 * ALL of them extracted planName/planYear/planType = null — e.g. DEV doc
 * 534eea3c (PacificSource Core Gold 1500, header at offset 3075) linked to no
 * canonical because plan_name is a canonical-matching dimension.
 *
 * S292 corpus measurement (scripts/s292-identity-extraction-corpus.ts) over
 * slice(0,2000) / slice(0,8000) / slice(0,100000) / header-anchored splicing:
 *   - 8,000 recovered identity on all 7 displaced-header docs with ZERO lost
 *     or corrupted fields vs the 2,000 baseline (insurer-vs-sponsor
 *     disambiguation held: the one PEO/sponsor doc in the corpus gained the
 *     true carrier, not the PEO).
 *   - 100,000 added only low-stakes state fills while INTRODUCING errors:
 *     a fabricated planYear on an EOC whose text contains no year, a verbatim
 *     plan-name token dropped, and a filled state value flipped — long-input
 *     dilution, at ~4x the tokens.
 *   - Header-anchored splicing produced outputs identical to the plain 8,000
 *     window: extra machinery, zero measured gain.
 *
 * Every observed header offset was <= 3,082 (the federal glossary preamble is
 * a standardized block), so 8,000 carries ~2.6x margin. KNOWN LIMIT: a header
 * beyond 8,000 chars would still be missed — no such document has been
 * observed (0/27).
 */
export const IDENTITY_WINDOW_CHARS = 8000;

/**
 * Pure input-selection for extractPlanIdentifiersWithHaiku — exported so
 * fixtures can lock the windowing behavior without a model call.
 */
export function selectIdentityWindow(ocrText: string): string {
  return ocrText.slice(0, IDENTITY_WINDOW_CHARS);
}

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

  const headerText = selectIdentityWindow(ocrText);

  try {
    const client = new Anthropic({ apiKey, timeout: 15000, maxRetries: 1 });
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 200,
      temperature: 0,
      messages: [{
        role: "user",
        content: `Extract the insurance plan identifiers from this document header. Return ONLY a JSON object with these fields (use null if not found):
{"insurer": "company name", "planName": "plan name", "groupNumber": "group #", "planYear": 2025, "planType": "HMO/PPO/etc", "state": "XX"}

IMPORTANT — insurer vs sponsor disambiguation:
- "insurer" must be the actual insurance CARRIER (e.g., Cigna, Aetna, Blue Shield, Kaiser, Anthem, UnitedHealthcare, Humana, BCBS).
- Do NOT use values labeled "POLICYHOLDER:", "Plan Sponsor:", "Plan Administrator:", "Employer Group:", or "Group:" — those identify the EMPLOYER / PEO / union / trust, NOT the insurance carrier (e.g., "Sequoia One PEO, LLC", "TriNet HR Corporation", "Insperity Group Plan", "ADP TotalSource" are PEOs, not insurers).
- The carrier is typically named on the cover or adjacent to phrases like "is offered by", "issued by", "administered by", or "underwritten by" (e.g., "Cigna Health and Life Insurance Company").
- If the document only names a sponsor/employer and no carrier is visible in this header text, set insurer to null.

Document text:
${headerText}`,
      }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    // S94 B1 — shared parseHaikuJSON handles trailing reasoning + code fences + jsonrepair.
    const parsed = parseHaikuJSON<Record<string, unknown>>(text);

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
//
// CF-40 v2 (Session 74) — per-document smart-skip eligibility.
//
// Smart-skip eligibility is now per `(canonical_plan_id, file_hash)` tuple,
// tracked in the canonical_document_stability table (mig 081). Each unique
// document hash must prove its own stability via 3 consecutive identical
// Haiku runs before that hash gets smart-skip eligibility on the canonical.
//
// Key behavior changes from CF-40 v1:
//   - Path A (file_hash match): instead of checking canonical-wide
//     `extraction_stable`, we check canonical_document_stability for THIS
//     specific (canonical, hash) pair. A new hash on a stable canonical is
//     NOT skipped — it must build its own stability via fresh Haiku runs.
//   - Path B (semantic-match smart-skip on first-time hash): REMOVED. New
//     hashes always run Haiku — even on canonicals stable via other docs —
//     because they may carry additional services / corrections.
//
// Per Pattern 1 #14 + user direction: "If a different document for the same
// plan is uploaded for the first time, we should parse it. It may have
// additional services or data and we want as robust a data picture as possible."

export async function shouldSkipExtraction(
  supabase: SupabaseClient,
  documentId: string,
  fileHash: string,
  _identifiers: PlanIdentifiers, // CF-40 v2: unused after Path B removal; kept in signature for caller stability
  _userId: string,
  docType?: ClassifiedDocType | null,
): Promise<DedupResult> {
  const NO_SKIP = (reason: string): DedupResult => ({ skip: false, reason });

  // ── CF-40 v4 (S73.5 D1) — Plan-document-only structural guard ──────────────
  // Codifies the invariant that smart-skip applies ONLY to plan documents (SBC,
  // EOC, plan_doc). Bills, EOBs, insurance cards carry per-transaction or
  // per-card data and never inherit from a canonical plan — they MUST extract.
  // If docType wasn't passed (legacy callers), fetch from documents row.
  let resolvedDocType: string | null | undefined = docType;
  if (resolvedDocType === undefined) {
    const { data: docRow } = await supabase
      .from("documents")
      .select("doc_type")
      .eq("id", documentId)
      .maybeSingle();
    resolvedDocType = docRow?.doc_type ?? null;
  }
  if (!isPlanDocumentType(resolvedDocType)) {
    console.log(`[extraction-dedup] CF-40v4 guard — docType=${resolvedDocType ?? "<null>"} not in plan-document whitelist; smart-skip refused.`);
    return NO_SKIP("not_a_plan_document");
  }

  // Step 1: Exact file hash match → trace to canonical → check per-(canonical, hash) stability
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
        // mig 218: carry the link's confidence, not just the link — the
        // smart-skip write below inherits it rather than inventing one.
        .select("canonical_plan_id, canonical_match_confidence")
        .eq("id", hashMatches[0].linked_insurance_plan_id)
        .single();

      if (linkedPlan?.canonical_plan_id) {
        // CF-40 v2: per-(canonical, hash) stability, not per-canonical.
        // CF-40 v4 (Ing-D.0b) additionally reads the Layer 2 weight + Layer 5
        // counters (parse_weight_accumulated / smart_skip_count / last_full_parse_at).
        const { data: stability } = await supabase
          .from("canonical_document_stability")
          .select(
            "haiku_output_stable, identical_parse_count, parse_weight_accumulated, smart_skip_count, last_full_parse_at",
          )
          .eq("canonical_plan_id", linkedPlan.canonical_plan_id)
          .eq("file_hash", fileHash)
          .maybeSingle();

        // CF-40 v4 (Ing-D.0b): flag-gated 5-layer smart-skip orchestrator. When
        // `cf40_v4_algorithm` is ON the orchestrator decision is authoritative;
        // when OFF (the only PROD state until Ing-D.1) or on error,
        // evaluateV4SmartSkip returns null and we fall through to the v3
        // haiku_output_stable check below (byte-identical legacy behavior).
        const v4PlanDocType = toPlanDocType(resolvedDocType);
        if (v4PlanDocType) {
          const v4Decision = await evaluateV4SmartSkip(supabase, {
            documentId,
            fileHash,
            userId: _userId,
            canonicalPlanId: linkedPlan.canonical_plan_id,
            canonicalMatchConfidence:
              (linkedPlan.canonical_match_confidence as number | null) ?? null,
            docType: v4PlanDocType,
            stability: {
              parseWeightAccumulated: (stability?.parse_weight_accumulated as number | null) ?? 0,
              smartSkipCount: (stability?.smart_skip_count as number | null) ?? 0,
              lastFullParseAt: (stability?.last_full_parse_at as string | null) ?? null,
            },
          });
          if (v4Decision !== null) return v4Decision;
        }

        // v3 path (flag OFF or v4 errored).
        if (stability?.haiku_output_stable) {
          console.log(`[extraction-dedup] (canonical=${linkedPlan.canonical_plan_id}, hash=${fileHash.slice(0, 12)}…) is stable (count=${stability.identical_parse_count}). SKIP.`);
          return {
            skip: true,
            canonicalPlanId: linkedPlan.canonical_plan_id,
            canonicalMatchConfidence:
              (linkedPlan.canonical_match_confidence as number | null) ?? null,
            reason: "doc_stable_per_canonical_hash",
          };
        }
        console.log(`[extraction-dedup] (canonical=${linkedPlan.canonical_plan_id}, hash=${fileHash.slice(0, 12)}…) NOT YET stable (count=${stability?.identical_parse_count ?? 0}). EXTRACT.`);
        return NO_SKIP("doc_not_yet_stable");
      }
    }
  }

  // Step 2: First-time hash on this canonical — always run Haiku (CF-40 v2 user direction).
  // Pre-CF-40-v2 had a Path B "semantic-match smart-skip" that fired when identifiers
  // (insurer + plan_name + plan_year) matched a stable canonical, smart-skipping new
  // file hashes. That path was REMOVED — new docs may carry additional services or
  // value corrections, and we want the most robust data picture per upload.
  return NO_SKIP("first_time_hash_always_extracts");
}

/**
 * CF-40 v4 (Ing-D.0b) — smart-skip orchestrator gather + decide.
 *
 * Called from shouldSkipExtraction's Step-1 seam ONLY when an incoming upload's
 * file_hash already matches a processed doc linked to a canonical. Gathers the
 * 5-layer orchestrator inputs and returns the eligibility decision as a
 * DedupResult.
 *
 * Returns null when `cf40_v4_algorithm` is OFF (the only PROD state until
 * Ing-D.1) OR on any gather error — the caller then falls back to the v3
 * `haiku_output_stable` check. When the flag is ON the orchestrator decision is
 * AUTHORITATIVE: eligible → skip; not-eligible → extract (never falls back to v3,
 * which could let a v3-stable hash skip a parse v4 wants re-run).
 *
 * Layer 1 at skip time evaluates only the U-specific gates (validity window on
 * the upload, file size, uploader auth/banned, canonical re-baseline). The
 * doc-quality gates (self-check / OCR / classification) are inherited via Layer 2:
 * a byte-identical hash match means the stable baseline — built from
 * Layer-1-passing parses to ≥ STABILITY_THRESHOLD weight — already certifies them,
 * so they are passed null (inapplicable) rather than re-evaluated on the re-upload.
 */
async function evaluateV4SmartSkip(
  supabase: SupabaseClient,
  args: {
    documentId: string;
    fileHash: string;
    userId: string;
    canonicalPlanId: string;
    /** mig 218 — confidence of the link being inherited; see DedupResult. */
    canonicalMatchConfidence?: number | null;
    docType: PlanDocType;
    stability: {
      parseWeightAccumulated: number;
      smartSkipCount: number;
      lastFullParseAt: string | null;
    };
  },
): Promise<DedupResult | null> {
  const {
    documentId,
    fileHash,
    userId,
    canonicalPlanId,
    canonicalMatchConfidence,
    docType,
    stability,
  } = args;
  try {
    // Uploader trust. userId = documents.user_id = the users PK (NOT firebase_uid;
    // the upload route writes user.id). Resolve by id. (S163 fix — the prior
    // .eq("firebase_uid", userId) never matched a UUID → uploader null → the v4 flag
    // read OFF + trust defaulted to unverified, silently disabling v4.)
    const { data: uploader } = await supabase
      .from("users")
      .select("is_admin, email_verified, phone_verified, email")
      .eq("id", userId)
      .maybeSingle();
    if (!uploader) {
      // Should always resolve for a real upload; a null means v4 can't gate/weight
      // this parse. Warn so this class can't silently regress again (S163).
      console.warn(
        `[cf40-v4] smart-skip: uploader lookup failed for users.id=${userId} — v4 disabled for this parse`,
      );
    }

    // Flag gate (per-user targeting for the Ing-D.1 staged rollout). OFF → null
    // so the caller runs the v3 path.
    const { isFeatureEnabled } = await import("@/lib/config/product-flags");
    const v4On = await isFeatureEnabled(
      "cf40_v4_algorithm",
      (uploader?.email as string | undefined) ?? undefined,
    );
    if (!v4On) return null;

    // Ship Gate G6: the thresholds this skip decision reads come from
    // cf40_v4_config (defaults to the pre-G6 constants → byte-identical when unset).
    const cfg = await loadCF40V4Config(supabase);

    const isAdmin = uploader?.is_admin === true;
    const tier = resolveTrustTier({
      isAdmin,
      phoneVerified: uploader?.phone_verified === true,
      emailVerified: uploader?.email_verified === true,
    });

    // Incoming upload's own document row (validity window + file size). U is
    // byte-identical to the baseline, but its upload time is its own.
    const { data: uDoc } = await supabase
      .from("documents")
      .select("created_at, plan_year, file_size")
      .eq("id", documentId)
      .maybeSingle();

    // Canonical scale tier + verification-mode flag.
    const { data: canonical } = await supabase
      .from("canonical_plans")
      .select("extraction_count, divergence_pending_verification")
      .eq("id", canonicalPlanId)
      .maybeSingle();
    const scaleTier = getScaleTier((canonical?.extraction_count as number | null) ?? 0, cfg.scale);

    // Per-doc-type promotion state (Layer 3 promoted + re-baseline + admin-attested).
    const { data: promo } = await supabase
      .from("canonical_doctype_promotion_state")
      .select("doctype_promoted, promotion_event_type, promoted_at, re_baseline_required")
      .eq("canonical_plan_id", canonicalPlanId)
      .eq("document_type", docType)
      .maybeSingle();
    const doctypePromoted = promo?.doctype_promoted === true;

    // Layer 5 admin-attestation validation: when promotion came from ADMIN
    // attestation, force a full parse UNTIL an organic (verified, non-admin)
    // upload has arrived since `promoted_at` — then organic data has validated
    // the attestation and skips may resume. Precise, NOT "always force on
    // admin-attested" (which would null out smart-skip for the cold-start
    // backbone forever, since promotion_event_type is sticky).
    let adminAttestedNeedsValidation = false;
    if (promo?.promotion_event_type === "admin_attested" && promo?.promoted_at) {
      adminAttestedNeedsValidation = !(await hasOrganicParseSince(
        supabase,
        canonicalPlanId,
        promo.promoted_at as string,
      ));
    }

    const validityInput: ValidityGateInput = {
      // Doc-quality inherited via Layer 2 (byte-identical hash) → inapplicable.
      selfCheckPassRate: null,
      ocrConfidence: null,
      classificationConfidence: null,
      uploadedAt: (uDoc?.created_at as string | null) ?? new Date().toISOString(),
      documentPlanYear: (uDoc?.plan_year as number | null) ?? null,
      fileSizeBytes: (uDoc?.file_size as number | null) ?? 0,
      docType,
      uploaderTier: tier,
      isAdmin,
      isBanned: false, // no platform ban mechanism yet (see process-plan.ts note)
      canonicalReBaselineRequired: promo?.re_baseline_required === true,
    };

    const forcedReparseInput: ForcedReparseInput = {
      isAdmin,
      scaleTier,
      smartSkipCount: stability.smartSkipCount,
      lastFullParseAt: stability.lastFullParseAt,
      divergencePendingVerification: canonical?.divergence_pending_verification === true,
      adminAttestedNeedsValidation,
    };

    const eligibility = evaluateSmartSkipEligibility({
      validityInput,
      layer2Stable: stability.parseWeightAccumulated >= cfg.weights.stabilityThreshold,
      doctypePromoted,
      forcedReparseInput,
    }, cfg);

    if (eligibility.eligible) {
      // Layer 5 every-5th-smart-skip counter: increment on each skip so the
      // forced-reparse sampler fires every 5th. Non-fatal.
      try {
        await supabase
          .from("canonical_document_stability")
          .update({ smart_skip_count: stability.smartSkipCount + 1 })
          .eq("canonical_plan_id", canonicalPlanId)
          .eq("file_hash", fileHash);
      } catch (incErr) {
        console.warn("[extraction-dedup] CF-40v4 smart_skip_count increment failed (non-fatal):", incErr);
      }
      console.log(
        `[extraction-dedup] CF-40v4 smart-skip ELIGIBLE (canonical=${canonicalPlanId}, doc=${docType}, weight=${stability.parseWeightAccumulated}). SKIP.`,
      );
      return {
        skip: true,
        canonicalPlanId,
        canonicalMatchConfidence: canonicalMatchConfidence ?? null,
        reason: "v4_skip:all_pass",
      };
    }

    console.log(
      `[extraction-dedup] CF-40v4 smart-skip NOT eligible (${eligibility.decisionLayer}:${eligibility.failureReason}). EXTRACT.`,
    );
    return {
      skip: false,
      reason: `v4_extract:${eligibility.decisionLayer}:${eligibility.failureReason ?? "unknown"}`,
      // Ing-D.0c-ii — non-null ONLY when Layer 5 forced a re-parse of an
      // otherwise-skip-eligible canonical (the verification/rapid-change signal).
      forcedReparseReason: eligibility.forcedReparseReason,
    };
  } catch (err) {
    console.warn("[extraction-dedup] CF-40v4 smart-skip eval error (non-fatal) → v3 fallback:", err);
    return null;
  }
}

/**
 * True iff an organic (email+phone-verified, non-admin) upload of this canonical
 * exists with created_at strictly after `sinceIso`. Powers the Layer 5
 * admin-attestation-validation trigger. Two-step (no FK embed): insurance_plans
 * since-time → users verified/non-admin. insurance_plans.user_id is users.id
 * (UUID), mirroring gatherLayer3Inputs.
 */
async function hasOrganicParseSince(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  sinceIso: string,
): Promise<boolean> {
  const { data: plans } = await supabase
    .from("insurance_plans")
    .select("user_id")
    .eq("canonical_plan_id", canonicalPlanId)
    .gt("created_at", sinceIso);
  const userIds = [...new Set((plans ?? []).map((p) => p.user_id as string))];
  if (userIds.length === 0) return false;
  const { data: users } = await supabase
    .from("users")
    .select("id")
    .in("id", userIds)
    .eq("is_admin", false)
    .eq("email_verified", true)
    .eq("phone_verified", true)
    .limit(1);
  return (users?.length ?? 0) > 0;
}

// ── 5. Link Document to Canonical (Skip Path) ─────────────────────────────────

export async function linkDocumentToCanonical(
  supabase: SupabaseClient,
  doc: { id: string; user_id: string; file_name: string },
  canonicalPlanId: string,
  ocrText: string,
  identifiers: PlanIdentifiers,
  /**
   * mig 218 — confidence of the canonical link this smart-skip is INHERITING
   * (from `DedupResult.canonicalMatchConfidence`). Optional so the parameter is
   * additive; `undefined`/`null` records UNKNOWN rather than a guess.
   */
  canonicalMatchConfidence?: number | null,
): Promise<ProcessPlanResult> {
  try {
    // Mig 078 — comparison uploads via /compare must never overwrite primary.
    // Smart-skip path also writes to insurance_plans + active_insurance_plan_id;
    // branch on purpose so comparison uploads stay isolated.
    const { data: docMetaForPurpose } = await supabase
      .from("documents")
      .select("purpose")
      .eq("id", doc.id)
      .single();
    const isComparisonUpload = docMetaForPurpose?.purpose === "comparison";

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
    // CF-19 (Session 73, S71) — when Haiku misses a field, we no longer fall back
    // to regex parsePlanDocument; field stays null + renders Hidden + page-level
    // re-upload prompt fires (Display State v3 vocabulary).
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
      // Non-fatal — plan-identity fields will fall back to canonical values
      // where available; otherwise render Hidden + page-level upload prompt
      // (CF-19, Session 73 — no longer falls through to regex parsePlanDocument).
      console.warn("[extraction-dedup] Hybrid Haiku Important Questions failed (non-fatal):", iqErr);
    }

    // Build plan-identity provenance: prefer Haiku output (cite-grade Pattern P-8);
    // fall back to canonical_inherited synthesis when Haiku didn't run / didn't extract.
    const planIdentityProvenanceFromHaiku: Record<string, FieldProvenanceEntry> = importantQuestionsHaiku
      ? buildSBCPlanIdentityProvenance(importantQuestionsHaiku, "doc_extraction", ["important_questions"])
      : {};

    // Resolve plan-identity field values.
    //
    // CF-19 (Session 73, S71) — IN-network deductible/OOP chains used to fall back
    // to `parseResult.plan.in_*` (regex parsePlanDocument output) when Haiku missed
    // the field. That regex was designed for plan_documents (49% recall floor; F.14)
    // and produces unreliable values on SBCs — and worse, because Haiku didn't emit
    // the field, the provenance synthesizer downstream tagged the row as
    // `canonical_inherited` while the value came from the regex. The result was a
    // value/provenance mismatch that degraded data quality on every SBC re-upload.
    //
    // Fix: remove the regex fallback. IN-network now follows the same shape as OON
    // — Haiku or null. Canonical fallback (further down) still applies on the IN
    // side because canonical may carry plan-identity from prior corroboration; OON
    // on canonical is null until promotion events populate it.
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
    const inDedIndividual = haikuVal(importantQuestionsHaiku?.deductibleIndividual);
    const inDedFamily = haikuVal(importantQuestionsHaiku?.deductibleFamily);
    const inOopIndividual = haikuVal(importantQuestionsHaiku?.oopMaxIndividual);
    const inOopFamily = haikuVal(importantQuestionsHaiku?.oopMaxFamily);
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

    // S102 follow-up — smart-skip mismatch detection (Andrew direction).
    // Smart-skip previously auto-committed canonical's plan to the user's
    // profile without confirmation, even if canonical's insurer/plan_name
    // differed from the user's existing profile. That's unsafe — user may
    // have uploaded the wrong file. Mirror process-plan.ts:587-660's
    // mismatch detection so the frontend can render the "Use this plan? /
    // Keep current?" prompt before any profile/insurance_plans commit.
    //
    // Comparison uploads are exempt (they're a separate side-by-side plan,
    // never replace the active plan).
    let smartSkipMismatch: {
      mismatch: boolean;
      type: "insurer" | "plan_name";
      existingInsurer: string;
      parsedInsurer: string;
      existingPlanName?: string;
      parsedPlanName?: string;
    } | null = null;
    if (!isComparisonUpload) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("insurer, plan_name")
        .eq("user_id", doc.user_id)
        .maybeSingle();
      const normalize = (s: string | null | undefined) =>
        (s || "").toLowerCase().replace(/\s*(insurance|company|inc|corp|health\s*plan)\s*/gi, "").trim();
      const canonicalInsurerName = insurer?.name ?? identifiers.insurer ?? "";
      const canonicalPlanName = canonical.plan_name ?? "";
      const profileInsurerN = normalize(profile?.insurer);
      const canonicalInsurerN = normalize(canonicalInsurerName);
      const profilePlanN = normalize(profile?.plan_name);
      const canonicalPlanN = normalize(canonicalPlanName);

      if (profileInsurerN && canonicalInsurerN
        && profileInsurerN !== canonicalInsurerN
        && !profileInsurerN.includes(canonicalInsurerN)
        && !canonicalInsurerN.includes(profileInsurerN)) {
        smartSkipMismatch = {
          mismatch: true,
          type: "insurer",
          existingInsurer: profile?.insurer || "",
          parsedInsurer: canonicalInsurerName,
        };
      } else if (profilePlanN && canonicalPlanN
        && profilePlanN !== canonicalPlanN
        && !profilePlanN.includes(canonicalPlanN)
        && !canonicalPlanN.includes(profilePlanN)) {
        smartSkipMismatch = {
          mismatch: true,
          type: "plan_name",
          existingInsurer: profile?.insurer || "",
          parsedInsurer: canonicalInsurerName,
          existingPlanName: profile?.plan_name,
          parsedPlanName: canonicalPlanName,
        };
      }
      if (smartSkipMismatch) {
        console.log(`[extraction-dedup] Smart-skip mismatch (${smartSkipMismatch.type})`);
        await supabase
          .from("documents")
          .update({ insurer_mismatch: smartSkipMismatch })
          .eq("id", doc.id);
      }
    }

    // Resolve final values with canonical fallback for IN-network only
    // (canonical schema doesn't carry OON for these; OON comes from Haiku or stays null).
    const finalInDed = inDedIndividual ?? canonical.deductible_individual ?? null;
    const finalInOop = inOopIndividual ?? canonical.oop_max_individual ?? null;

    // Check for existing active plan to merge into. Comparison uploads SKIP
    // the merge path entirely (a comparison plan is a separate plan, not an
    // enrichment of the user's primary).
    const { data: existingPlan } = isComparisonUpload
      ? { data: null }
      : await supabase
          .from("insurance_plans")
          .select("id, field_provenance")
          .eq("user_id", doc.user_id)
          .eq("is_active", true)
          .single();

    // Build the canonical_inherited provenance for any plan-identity field WITHOUT
    // Haiku-extracted provenance. Pattern 1 #14 honored — written to user-scoped table
    // only as inheritance pointer; canonical untouched.
    //
    // CF-19 (Session 73, S71) — every entry now gates on `value !== null`, matching
    // the OON pattern. Previous IN-network entries unconditionally added a
    // canonical_inherited row even when value was null — that produced phantom
    // provenance entries (source = "canonical_inherited" with no actual value),
    // which the consumer-read filter then routed to "Community" badge state on a
    // null cell. The right behavior is: when neither Haiku nor canonical has the
    // value, write nothing → consumer-read renders Hidden + page-level upload prompt.
    // CF-40 (Session 74): smart-skip path — user uploaded a document that hashed to a
    // 3-parse-stable canonical. Synthesized provenance gets `source='doc_extraction_smart_skip'`
    // (NEW v4 source value) so getDisplayState routes to user_verified_community dual-badge
    // instead of plain Community. Honors Pattern 1 #14 (writes to user-scoped only) and
    // gives the user credit for their upload contribution. See [[Candid_10k]] §3.1 §6.
    const canonicalInheritedFallback = buildCanonicalInheritedProvenance(
      "insurance_plans",
      [
        // Only include fields where Haiku didn't already produce provenance AND
        // a non-null value is available (from canonical fallback or directly).
        ...(planIdentityProvenanceFromHaiku.plan_name ? [] : (planNameValue ?? canonical.plan_name) != null ? [["plan_name", planNameValue ?? canonical.plan_name] as [string, unknown]] : []),
        ...(planIdentityProvenanceFromHaiku.insurer_name ? [] : (insurer?.name ?? identifiers.insurer) != null ? [["insurer_name", insurer?.name ?? identifiers.insurer] as [string, unknown]] : []),
        ...(planIdentityProvenanceFromHaiku.plan_type ? [] : (planTypeValue ?? canonical.plan_type) != null ? [["plan_type", planTypeValue ?? canonical.plan_type] as [string, unknown]] : []),
        ...(planIdentityProvenanceFromHaiku.plan_year ? [] : planYearValue != null ? [["plan_year", planYearValue] as [string, unknown]] : []),
        ...(planIdentityProvenanceFromHaiku.in_deductible_individual ? [] : finalInDed != null ? [["in_deductible_individual", finalInDed] as [string, unknown]] : []),
        ...(planIdentityProvenanceFromHaiku.in_deductible_family ? [] : inDedFamily != null ? [["in_deductible_family", inDedFamily] as [string, unknown]] : []),
        ...(planIdentityProvenanceFromHaiku.in_oop_max_individual ? [] : finalInOop != null ? [["in_oop_max_individual", finalInOop] as [string, unknown]] : []),
        ...(planIdentityProvenanceFromHaiku.in_oop_max_family ? [] : inOopFamily != null ? [["in_oop_max_family", inOopFamily] as [string, unknown]] : []),
        // OON: canonical doesn't carry OON values today (CF-19c forward-looking — mig 071 added cols
        // but legacy canonicals are unpopulated until promotion events fire post-corroboration).
        ...(planIdentityProvenanceFromHaiku.out_deductible_individual ? [] : outDedIndividual != null ? [["out_deductible_individual", outDedIndividual] as [string, unknown]] : []),
        ...(planIdentityProvenanceFromHaiku.out_deductible_family ? [] : outDedFamily != null ? [["out_deductible_family", outDedFamily] as [string, unknown]] : []),
        ...(planIdentityProvenanceFromHaiku.out_oop_max_individual ? [] : outOopIndividual != null ? [["out_oop_max_individual", outOopIndividual] as [string, unknown]] : []),
        ...(planIdentityProvenanceFromHaiku.out_oop_max_family ? [] : outOopFamily != null ? [["out_oop_max_family", outOopFamily] as [string, unknown]] : []),
      ],
      "doc_extraction_smart_skip", // CF-40 source: smart-skip on stable canonical, user contributed via upload
    );

    // Merged plan-identity field_provenance: Haiku-extracted + smart-skip fallback.
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
        ...canonicalLinkFields(canonicalPlanId, canonicalMatchConfidence ?? null),
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
      // Create new plan linked to canonical.
      // Comparison uploads: skip deactivating the user's existing active plan
      // (their primary stays primary) and insert with is_active=false.
      // S102 follow-up: if smart-skip mismatch detected (profile insurer/plan
      // disagrees with canonical), insert with is_active=false too — user must
      // confirm via "Use this plan?" prompt before activation.
      const shouldActivate = !isComparisonUpload && !smartSkipMismatch;
      // S317 — captured under the SAME `shouldActivate` guard as the
      // deactivation, so comparison uploads and smart-skip mismatches (which
      // never deactivate anything) leave this empty and strand nothing.
      let activeBeforeIds: string[] = [];
      if (shouldActivate) {
        const { data: activeBeforeRows } = await supabase
          .from("insurance_plans")
          .select("id")
          .eq("user_id", doc.user_id)
          .eq("is_active", true);
        activeBeforeIds = (activeBeforeRows ?? []).map((p: { id: string }) => p.id);
        await supabase.from("insurance_plans")
          .update({ is_active: false })
          .eq("user_id", doc.user_id)
          .eq("is_active", true);
      }

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
          is_active: shouldActivate,
          // S320 — mig-231 stamp contract: this writer used the variable form
          // (`is_active: shouldActivate`) and evaded the activation guard's
          // literal-true scan, shipping activations with NO activated_at.
          activated_at: shouldActivate ? new Date().toISOString() : null,
          ...canonicalLinkFields(canonicalPlanId, canonicalMatchConfidence ?? null),
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

      // Update profile — only when activating the plan (no mismatch, no
      // comparison upload). On mismatch, profile stays as-is until user
      // confirms via "Use this plan?" prompt (handled by activate_plan API).
      if (shouldActivate) {
        const profileUpdate: Record<string, unknown> = { active_insurance_plan_id: targetPlanId };
        if (identifiers.insurer) profileUpdate.insurer = identifiers.insurer;
        if (identifiers.planName) profileUpdate.plan_name = identifiers.planName;
        await supabase.from("profiles").update(profileUpdate).eq("user_id", doc.user_id);
        // S320 — the claim-follow family in one call: unlinked claims adopt
        // this newly-active plan (S315 — this dedup path is the same-bytes
        // re-upload door, exactly the /check gap's sibling) + claims on the
        // plan(s) this one supersedes follow it (S317).
        await finalizePlanActivation(
          supabase,
          doc.user_id as string,
          targetPlanId as string,
          activeBeforeIds,
        );
      }
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
          // smart-skip synthesis.
          // CF-40 (Session 74): smart-skip synthesis now writes `source='doc_extraction_smart_skip'`
          // (NEW v4 source value) so getDisplayState routes user-side rows to the
          // user_verified_community dual-badge tier. See [[Candid_10k]] §3.1 §6.
          const canonicalProvenance = (s.field_provenance as Record<string, FieldProvenanceEntry> | null) ?? null;
          const provenance = canonicalProvenance && Object.keys(canonicalProvenance).length > 0
            ? canonicalProvenance
            : buildCanonicalInheritedProvenance("plan_covered_services", [
                ["in_copay", s.in_copay],
                ["in_coinsurance", normalizeCoinsuranceForStorage(s.in_coinsurance)],
                ["in_deductible_applies", s.in_deductible_applies],
                ["covered", s.covered !== false],
                ["prior_auth_required", s.prior_auth_required || false],
                ["annual_limit_value", s.annual_limit],
                // CF-19c: OON cost-sharing if canonical now carries them (mig 071)
                ["out_copay", s.out_copay],
                ["out_coinsurance", normalizeCoinsuranceForStorage(s.out_coinsurance)],
                ["out_deductible_applies", s.out_deductible_applies],
              ], "doc_extraction_smart_skip");

          return {
            insurance_plan_id: targetPlanId,
            service_id: slugToId.get(s.service_slug!)!,
            concept_id: s.concept_id || null,
            place_of_service: "any",
            component: "global" as const,
            in_copay: s.in_copay,
            in_coinsurance: normalizeCoinsuranceForStorage(s.in_coinsurance),
            in_deductible_applies: s.in_deductible_applies,
            // CF-19c: OON cost-sharing from canonical (mig 071 — null until populated by promotion events)
            out_copay: s.out_copay ?? null,
            out_coinsurance: normalizeCoinsuranceForStorage(s.out_coinsurance),
            out_deductible_applies: s.out_deductible_applies ?? null,
            covered: s.covered !== false,
            prior_auth_required: s.prior_auth_required || false,
            // CF-63 RC-2 (S128): nullish coalescing preserves $0 annual limits.
            annual_limit_value: s.annual_limit ?? null,
            confidence: s.confidence,
            source: "sbc_parsed" as const,
            field_provenance: provenance,
          };
        });

      if (serviceInserts.length > 0) {
        const { error: svcError } = await applyPlanCoverageCell(supabase, serviceInserts);
        if (svcError) console.error("[extraction-dedup] Service copy failed:", svcError);
      }

      console.log(`[extraction-dedup] Copied ${serviceInserts.length} services from canonical to plan ${targetPlanId}`);
    }

    // Mark document as processed + flag smart-skip outcome in metadata so the
    // status endpoint can surface it and the frontend can use accelerated
    // page-tick + sub-phase intervals (S102 follow-up for snappy smart-skip UX).
    // We jsonb-merge rather than overwrite so we don't clobber existing keys
    // (e.g., classification_override).
    const { data: existingDoc } = await supabase
      .from("documents")
      .select("metadata")
      .eq("id", doc.id)
      .maybeSingle();
    const mergedMetadata = {
      ...((existingDoc?.metadata as Record<string, unknown>) ?? {}),
      smart_skip_outcome: "skipped",
    };
    await supabase.from("documents").update({
      status: "processed",
      linked_insurance_plan_id: targetPlanId,
      processing_step: null,
      metadata: mergedMetadata,
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
        // CF-19 (S71) — return Haiku-resolved values (with canonical fallback for
        // IN-network only) instead of regex parsePlanDocument output. Mirrors the
        // values written to insurance_plans so the upload UI display matches the
        // persisted state.
        planName: planNameValue ?? canonical.plan_name,
        planType: planTypeValue ?? canonical.plan_type,
        inDeductible: finalInDed,
        outDeductible: outDedIndividual,
        inOopMax: finalInOop,
        outOopMax: outOopIndividual,
        servicesExtracted: canonicalServices?.length || 0,
      },
    };
  } catch (err) {
    console.error("[extraction-dedup] linkDocumentToCanonical error:", err);
    return { success: false, error: "Failed to link document to canonical plan" };
  }
}

// ── 6. Post-Extraction Tracking ────────────────────────────────────────────────

/**
 * CF-40 (Session 74): plan-identity cost values used for parse-event stability comparison.
 * 4 fields define "Haiku output stability" — counter increments when these match the prior
 * snapshot, resets to 1 when they diverge. See [[Candid_10k]] §3.1 §6.
 */
export interface HaikuPlanIdentityValues {
  in_deductible_individual: number | null;
  in_deductible_family: number | null;
  in_oop_max_individual: number | null;
  in_oop_max_family: number | null;
}

/**
 * CF-40 v4 (Ing-D.0a) — uploader + doc context for the Layer 2/3 promotion
 * recorder. Passed from the parser surface (process-plan.ts) so
 * recordExtractionResult can fire recordParseEventV4 after the v3 stability write.
 *
 * `docType` MUST be the TRUE type from `documents.classified_type`, NOT the
 * in-memory classification arg — `unified_plan_doc_parser_v1` coerces that to
 * 'plan_document' for SBC/EOC/plan_document alike (process-chunk:502).
 */
export interface ParseEventContext {
  docType: ClassifiedDocType;
  uploadedAt: Date;
  uploaderIsAdmin: boolean;
  uploaderEmailVerified: boolean;
  uploaderPhoneVerified: boolean;
  uploaderEmail?: string;
  // ── CF-40 v4 Layer 1 contribution-gate inputs (Ing-D.0b) ──────────────────
  // Sourced at the parse caller (process-plan.ts). selfCheckPassRate +
  // ocrConfidence are nullable — null = the parse path produced no such signal,
  // so that gate is inapplicable (see ValidityGateInput). The recorder reads
  // re_baseline_required canonical-side itself.
  selfCheckPassRate: number | null;
  ocrConfidence: number | null;
  classificationConfidence: number | null;
  fileSizeBytes: number;
  documentPlanYear: number | null;
  uploaderIsBanned: boolean;
  // ── Layer 4 forced-reparse signal (Ing-D.0c-ii) ───────────────────────────
  // Read from documents.cf40_forced_reparse_reason (persisted at smart-skip time;
  // mig 141). null = not a forced re-parse. Drives verification-mode open/resolve.
  forcedReparseReason: ForcedReparseReason | null;
}

export async function recordExtractionResult(
  supabase: SupabaseClient,
  documentId: string,
  canonicalPlanId: string,
  userId: string,
  fileHash: string | null,
  extractedServiceSlugs: string[],
  haikuPlanIdentityValues?: HaikuPlanIdentityValues,
  parseEventContext?: ParseEventContext,
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

    // Increment canonical-level extraction telemetry (count + last_extraction_at).
    // CF-40 v2: per-canonical identical_parse_count + last_haiku_extracted_values
    // are DEPRECATED (mig 081 comments) — replaced by canonical_document_stability
    // per-(canonical, hash). Skip writes to those columns.
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

    // ── CF-40 v3: per-(canonical, hash) stability tracking with multi-slot ──
    // candidate array + outlier-elimination eviction + services-drift NO_OP guard.
    //
    // Skip if no file_hash (can't track stability per hash) or no plan-identity values.
    if (!fileHash || !haikuPlanIdentityValues) {
      return;
    }

    const { data: existingStability } = await supabase
      .from("canonical_document_stability")
      .select("identical_parse_count, last_haiku_extracted_values, candidate_slots, upload_count")
      .eq("canonical_plan_id", canonicalPlanId)
      .eq("file_hash", fileHash)
      .maybeSingle();

    const planIdentityEqual = (a: HaikuPlanIdentityValues | null, b: HaikuPlanIdentityValues | null): boolean => {
      if (!a || !b) return false;
      return (a.in_deductible_individual ?? null) === (b.in_deductible_individual ?? null)
        && (a.in_deductible_family ?? null) === (b.in_deductible_family ?? null)
        && (a.in_oop_max_individual ?? null) === (b.in_oop_max_individual ?? null)
        && (a.in_oop_max_family ?? null) === (b.in_oop_max_family ?? null);
    };

    // CF-40 v3: SlotEntry shape stored in canonical_document_stability.candidate_slots[].
    interface SlotEntry {
      values: HaikuPlanIdentityValues;
      services_count: number;
      match_count: number;
      first_seen_at: string;
      last_seen_at: string;
    }

    // Distance metric (lex: mismatches primary, services_delta secondary).
    // Per user direction Session 74: count of mismatches across the 4 plan-identity
    // cost fields (Hamming-like) + |services_count delta| as secondary tiebreaker.
    const slotDistance = (a: SlotEntry, b: SlotEntry): number => {
      let mismatches = 0;
      if ((a.values.in_deductible_individual ?? null) !== (b.values.in_deductible_individual ?? null)) mismatches++;
      if ((a.values.in_deductible_family ?? null) !== (b.values.in_deductible_family ?? null)) mismatches++;
      if ((a.values.in_oop_max_individual ?? null) !== (b.values.in_oop_max_individual ?? null)) mismatches++;
      if ((a.values.in_oop_max_family ?? null) !== (b.values.in_oop_max_family ?? null)) mismatches++;
      const servicesDelta = Math.abs(a.services_count - b.services_count);
      return mismatches * 1000 + servicesDelta;
    };

    // CF-40 v3 eviction — drop the candidate with HIGHEST isolation (sum of
    // distances to other candidates). Cluster of consensus survives; isolated
    // outlier dropped. Tiebreakers: lower match_count → older last_seen_at.
    const evictOutlier = (slots: SlotEntry[]): SlotEntry[] => {
      if (slots.length <= 2) return slots;
      const ranked = slots.map((c, i) => ({
        idx: i,
        slot: c,
        isolation: slots.reduce((sum, other, j) => i === j ? sum : sum + slotDistance(c, other), 0),
      }));
      // Sort to find the candidate to DROP (highest isolation; tiebreak by lower
      // match_count; final tiebreak by older last_seen_at).
      ranked.sort((a, b) => {
        if (b.isolation !== a.isolation) return b.isolation - a.isolation;
        if (a.slot.match_count !== b.slot.match_count) return a.slot.match_count - b.slot.match_count;
        return a.slot.last_seen_at < b.slot.last_seen_at ? -1 : 1;
      });
      const dropIdx = ranked[0].idx;
      return slots.filter((_, i) => i !== dropIdx);
    };

    const nowIso = new Date().toISOString();

    let nextStability: {
      identical_parse_count: number;
      last_haiku_extracted_values: HaikuPlanIdentityValues | null;
      candidate_slots: SlotEntry[];
      haiku_output_stable: boolean;
      upload_count: number;
    };

    if (!existingStability) {
      // First parse of this (canonical, hash) — establish baseline at count=1.
      nextStability = {
        identical_parse_count: 1,
        last_haiku_extracted_values: haikuPlanIdentityValues,
        candidate_slots: [],
        haiku_output_stable: false,
        upload_count: 1,
      };
      console.log(`[extraction-dedup] CF-40v3 (canonical=${canonicalPlanId}, hash=${fileHash.slice(0, 12)}…) baseline established (count=1).`);
    } else {
      const baseline = (existingStability.last_haiku_extracted_values as HaikuPlanIdentityValues | null) ?? null;
      const slots = ((existingStability.candidate_slots as SlotEntry[] | null) ?? []);

      // ── Services-drift NO_OP guard ───────────────────────────────────────
      // newServicesFound > 0 means this Haiku run discovered services not yet
      // on canonical. Per user spec: "counter increments only when Haiku returns
      // no additional items or corrections" — services drift = informative for
      // canonical's service-set growth but not for hash-stability. Preserve all
      // stability state; bump only upload_count + last_seen_at.
      if (newServicesFound > 0) {
        nextStability = {
          identical_parse_count: existingStability.identical_parse_count,
          last_haiku_extracted_values: baseline,
          candidate_slots: slots,
          haiku_output_stable: existingStability.identical_parse_count >= 3,
          upload_count: existingStability.upload_count + 1,
        };
        console.log(`[extraction-dedup] CF-40v3 (canonical=${canonicalPlanId}, hash=${fileHash.slice(0, 12)}…) services-drift run (newServicesFound=${newServicesFound}) → all stability state preserved.`);
      } else if (planIdentityEqual(haikuPlanIdentityValues, baseline)) {
        // Baseline match — increment counter; clear all candidates (consensus around baseline).
        const nextCount = existingStability.identical_parse_count + 1;
        nextStability = {
          identical_parse_count: nextCount,
          last_haiku_extracted_values: baseline,
          candidate_slots: [],
          haiku_output_stable: nextCount >= 3,
          upload_count: existingStability.upload_count + 1,
        };
        console.log(
          nextStability.haiku_output_stable
            ? `[extraction-dedup] CF-40v3 (canonical=${canonicalPlanId}, hash=${fileHash.slice(0, 12)}…) STABLE (count=${nextCount}, smart-skip eligible from next upload).`
            : `[extraction-dedup] CF-40v3 (canonical=${canonicalPlanId}, hash=${fileHash.slice(0, 12)}…) baseline match (count=${nextCount}, need ${3 - nextCount} more).`,
        );
      } else {
        // Doesn't match baseline. Check candidate slots for value match.
        const matchingSlotIdx = slots.findIndex((s) => planIdentityEqual(haikuPlanIdentityValues, s.values));

        if (matchingSlotIdx !== -1) {
          // Existing candidate corroborates — bump match_count.
          const updatedSlot: SlotEntry = {
            ...slots[matchingSlotIdx],
            match_count: slots[matchingSlotIdx].match_count + 1,
            last_seen_at: nowIso,
          };
          const updatedSlots = slots.map((s, i) => (i === matchingSlotIdx ? updatedSlot : s));

          if (updatedSlot.match_count >= 3) {
            // PROMOTE — this slot's values become new baseline; all candidates cleared.
            nextStability = {
              identical_parse_count: updatedSlot.match_count,
              last_haiku_extracted_values: updatedSlot.values,
              candidate_slots: [],
              haiku_output_stable: true,
              upload_count: existingStability.upload_count + 1,
            };
            console.log(`[extraction-dedup] CF-40v3 (canonical=${canonicalPlanId}, hash=${fileHash.slice(0, 12)}…) CANDIDATE PROMOTED to baseline (slot ${matchingSlotIdx}, count=${updatedSlot.match_count}). Stable; all candidates cleared.`);
          } else {
            nextStability = {
              identical_parse_count: existingStability.identical_parse_count,
              last_haiku_extracted_values: baseline,
              candidate_slots: updatedSlots,
              haiku_output_stable: existingStability.identical_parse_count >= 3,
              upload_count: existingStability.upload_count + 1,
            };
            console.log(`[extraction-dedup] CF-40v3 (canonical=${canonicalPlanId}, hash=${fileHash.slice(0, 12)}…) candidate corroborated (slot ${matchingSlotIdx}, count=${updatedSlot.match_count}, need ${3 - updatedSlot.match_count} more to promote).`);
          }
        } else {
          // New distinct value — append candidate slot. Eviction if > 2 slots.
          const newSlot: SlotEntry = {
            values: haikuPlanIdentityValues,
            services_count: extractedServiceSlugs.length,
            match_count: 1,
            first_seen_at: nowIso,
            last_seen_at: nowIso,
          };
          const appended = [...slots, newSlot];
          const evicted = evictOutlier(appended);

          nextStability = {
            identical_parse_count: existingStability.identical_parse_count,
            last_haiku_extracted_values: baseline,
            candidate_slots: evicted,
            haiku_output_stable: existingStability.identical_parse_count >= 3,
            upload_count: existingStability.upload_count + 1,
          };

          if (appended.length > evicted.length) {
            console.log(`[extraction-dedup] CF-40v3 (canonical=${canonicalPlanId}, hash=${fileHash.slice(0, 12)}…) new candidate appended; outlier-eliminated (slots: ${appended.length} → ${evicted.length}; baseline preserved at count=${existingStability.identical_parse_count}).`);
          } else {
            console.log(`[extraction-dedup] CF-40v3 (canonical=${canonicalPlanId}, hash=${fileHash.slice(0, 12)}…) new candidate registered (slots: ${evicted.length}; baseline preserved at count=${existingStability.identical_parse_count}).`);
          }
        }
      }
    }

    await supabase
      .from("canonical_document_stability")
      .upsert(
        {
          canonical_plan_id: canonicalPlanId,
          file_hash: fileHash,
          identical_parse_count: nextStability.identical_parse_count,
          last_haiku_extracted_values: nextStability.last_haiku_extracted_values,
          candidate_slots: nextStability.candidate_slots,
          haiku_output_stable: nextStability.haiku_output_stable,
          upload_count: nextStability.upload_count,
          last_seen_at: nowIso,
          updated_at: nowIso,
        },
        { onConflict: "canonical_plan_id,file_hash" },
      );

    // ── CF-40 v4 (Ing-D.0a) — Layer 2 weight + Layer 3 promotion recorder ──
    // Flag-gated INSIDE recordParseEventV4 (no-op when cf40_v4_algorithm is OFF —
    // the only PROD state until Ing-D.1). Dynamic import avoids a static cycle
    // (record-parse-event imports isPlanDocumentType from this module). Non-fatal:
    // never block the v3 stability write above. Requires parseEventContext (TRUE
    // doc_type + uploader trust) from the parser surface.
    if (parseEventContext) {
      try {
        const { recordParseEventV4 } = await import(
          "@/lib/parser/cf40-v4/record-parse-event"
        );
        const v4Baseline =
          (existingStability?.last_haiku_extracted_values as HaikuPlanIdentityValues | null) ??
          null;
        await recordParseEventV4(supabase, {
          canonicalPlanId,
          fileHash,
          documentId,
          userId,
          docType: parseEventContext.docType,
          uploadedAt: parseEventContext.uploadedAt,
          uploaderIsAdmin: parseEventContext.uploaderIsAdmin,
          uploaderEmailVerified: parseEventContext.uploaderEmailVerified,
          uploaderPhoneVerified: parseEventContext.uploaderPhoneVerified,
          uploaderEmail: parseEventContext.uploaderEmail,
          newServicesFound,
          haikuPlanIdentityMatchesBaseline: v4Baseline
            ? planIdentityEqual(haikuPlanIdentityValues, v4Baseline)
            : true,
          // CF-40 v4 Layer 1 contribution-gate inputs (Ing-D.0b).
          selfCheckPassRate: parseEventContext.selfCheckPassRate,
          ocrConfidence: parseEventContext.ocrConfidence,
          classificationConfidence: parseEventContext.classificationConfidence,
          fileSizeBytes: parseEventContext.fileSizeBytes,
          documentPlanYear: parseEventContext.documentPlanYear,
          uploaderIsBanned: parseEventContext.uploaderIsBanned,
          // CF-40 v4 Layer 4 inputs (Ing-D.0c-ii) — the forced-reparse signal +
          // the raw identity tuple (served-baseline divergence + rapid-change).
          forcedReparseReason: parseEventContext.forcedReparseReason,
          haikuPlanIdentityValues,
        });
      } catch (v4Err) {
        console.error("[extraction-dedup] recordParseEventV4 error (non-fatal):", v4Err);
      }
    }
  } catch (err) {
    // Non-fatal — don't break the main pipeline
    console.error("[extraction-dedup] recordExtractionResult error (non-fatal):", err);
  }
}
