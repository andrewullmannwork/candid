// Ing-G.2/3 — ingest-time orchestrator for the adversarial-PDF assessment.
//
// Called at the start of BOTH PDF parse entry points (process-chunk INIT +
// the legacy /api/documents/process route). Self-contained: reads its own flag,
// doc metadata, and writes the result — the caller passes only (supabase,
// documentId, bytes). IDEMPOTENT (skips if already assessed → retry/reprocess
// safe) and NON-FATAL (never throws → never blocks a parse; matches the OCR
// layer's "never crash the upload flow" discipline + Cost-F/Ing-K telemetry).
//
// Flag semantics (mig 153): enabled=false → never runs (byte-identical).
// enabled=true → config.mode shadow (telemetry only) | enforce (admin work-list).
// Never auto-rejects — admin review only at MVP.

import type { SupabaseClient } from "@supabase/supabase-js";
import { extractAdversarialPdfFeatures } from "./adversarial-pdf-features";
import {
  scoreAdversarialPdf,
  resolveAdversarialConfig,
  DEFAULT_ADVERSARIAL_CONFIG,
  type AdversarialPdfConfig,
} from "./adversarial-pdf";
import { resolveEffectiveDocType, type DocTypePick } from "@/lib/documents/effective-doc-type";

const FLAG_KEY = "adversarial_pdf_detection";
/** Bump when the scorer logic/feature set changes, so G7 telemetry can group
 *  scores by the code that produced them (config tuning is tracked separately
 *  via the stored mode/threshold). A bump makes idempotency re-score an
 *  UNREVIEWED doc on its next parse (see assessAdversarialPdf).
 *  g23-v2 (S172): evidence-gated structural (header + ≥1 marker) + ingest scope. */
export const ADVERSARIAL_RULESET_VERSION = "g23-v2";

export interface AdversarialPriorAssessment {
  review_state?: string;
  ruleset_version?: string;
}

/** Idempotency decision (S171 Minor): skip re-assessment when a prior assessment
 *  is human-reviewed (Confirmed/Cleared — the decision is final across scorer
 *  versions) OR already at the current ruleset. An UNREVIEWED prior at an older
 *  ruleset re-scores — a logic bump should re-grade docs no admin has judged. No
 *  prior → assess. Pure + exported for fixture coverage. */
export function shouldSkipReassessment(
  prior: AdversarialPriorAssessment | undefined,
  currentRuleset: string,
): boolean {
  if (!prior) return false;
  const reviewed = prior.review_state === "confirmed" || prior.review_state === "cleared";
  return reviewed || prior.ruleset_version === currentRuleset;
}

/** Read the master gate + tunable config from the single flag row (mirrors
 *  loadCF40V4Config). Fails closed: any error → disabled. */
async function loadAdversarialPdfFlag(
  supabase: SupabaseClient,
): Promise<{ enabled: boolean; config: AdversarialPdfConfig }> {
  try {
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("enabled, config")
      .eq("flag_key", FLAG_KEY)
      .maybeSingle();
    return {
      enabled: data?.enabled === true,
      config: resolveAdversarialConfig((data?.config as Partial<AdversarialPdfConfig>) ?? null),
    };
  } catch {
    return { enabled: false, config: DEFAULT_ADVERSARIAL_CONFIG };
  }
}

export interface AssessAdversarialResult {
  ran: boolean;
  reason?: "disabled" | "already_assessed" | "out_of_scope" | "error";
  flagged?: boolean;
  assessable?: boolean;
  score?: number;
}

/**
 * Assess a PDF at ingest. Writes `documents.metadata.adversarial_pdf_assessment`
 * when the flag is enabled. Returns a small status object; callers ignore it
 * (fire-and-forget) — this never blocks the parse.
 */
export async function assessAdversarialPdf(
  supabase: SupabaseClient,
  documentId: string,
  bytes: Uint8Array,
): Promise<AssessAdversarialResult> {
  try {
    const { enabled, config } = await loadAdversarialPdfFlag(supabase);
    if (!enabled) return { ran: false, reason: "disabled" };

    const { data: doc } = await supabase
      .from("documents")
      .select("doc_type, classified_type, classification_confidence, processing_total_pages, metadata")
      .eq("id", documentId)
      .maybeSingle();

    // Scope (S171 Finding D): assess only documents that route into the PLAN
    // pipeline — where a fake poisons a canonical. Use the SAME resolver the
    // parser routes on (not a parallel type list) so scope can't drift from
    // routing; this skips bills / EOB / cards, whose sparse structure would
    // false-trip the artifact signals. classified_type + doc_type are set at
    // upload (quick-classify), before this runs; a null doc_type assumes
    // plan_document (assess — never disable the sensor on missing data).
    const effectiveType = resolveEffectiveDocType(
      ((doc?.doc_type as string | null) ?? "plan_document") as DocTypePick,
      (doc?.classified_type as string | null) ?? "",
      (doc?.classification_confidence as number | null) ?? 0,
      (doc?.processing_total_pages as number | null) ?? 0,
    ).effectiveDocType;
    if (effectiveType !== "sbc" && effectiveType !== "plan_document" && effectiveType !== "eoc") {
      return { ran: false, reason: "out_of_scope" };
    }

    const existing = (doc?.metadata as Record<string, unknown> | null) ?? {};
    const prior = existing.adversarial_pdf_assessment as AdversarialPriorAssessment | undefined;
    // Idempotent + ruleset-aware + review-preserving — see shouldSkipReassessment.
    if (shouldSkipReassessment(prior, ADVERSARIAL_RULESET_VERSION)) {
      return { ran: false, reason: "already_assessed" };
    }

    const features = await extractAdversarialPdfFeatures(bytes);
    const result = scoreAdversarialPdf(features, config);

    const assessment = {
      score: result.score,
      flagged: result.flagged,
      assessable: result.assessable,
      reasons: result.reasons,
      features, // full vector → G7 shadow-scoring reconciliation vs the corpus
      // `mode` is advisory only today: nothing branches on shadow vs enforce, and
      // the work-list surfaces flagged docs in ANY mode. `enforce` will mean
      // "quarantine the flywheel contribution" once ID-Block ships (Finding A).
      mode: config.mode,
      threshold: config.threshold, // operating point that produced `flagged`
      ruleset_version: ADVERSARIAL_RULESET_VERSION,
      review_state: "unreviewed" as const,
      scored_at: new Date().toISOString(),
    };

    await supabase
      .from("documents")
      .update({ metadata: { ...existing, adversarial_pdf_assessment: assessment } })
      .eq("id", documentId);

    return { ran: true, flagged: result.flagged, assessable: result.assessable, score: result.score };
  } catch (err) {
    // Non-fatal: an adversarial-scoring failure must never block a parse.
    console.warn(`[adversarial-pdf] assess failed for ${documentId}: ${(err as Error).message}`);
    return { ran: false, reason: "error" };
  }
}
