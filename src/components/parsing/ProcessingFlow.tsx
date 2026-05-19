"use client";

/**
 * ProcessingFlow — single deterministic dispatcher for the /upload post-upload
 * UX (S100 structural fix).
 *
 * Replaces the three top-level render branches that lived in UploadForm
 * (PlayfulParsingScreen at line 1037 + legacy Upload/Read/Extract/Save loader
 * at line 1149 + main form return where the modal at line 1996 lived
 * unreachable while `uploaded === true`).
 *
 * Priority-ordered dispatch (first match wins):
 *
 *   0  awaiting_confirmation → <DocTypeConfirmationModal>
 *   1  pending_review        → <ParseTerminalView variant="unusable" kind="pending_review">
 *   2  rejected              → <ParseTerminalView variant="unusable" kind="rejected">
 *   3  dedup_processed       → <ParseTerminalView variant="dedup_processed">
 *   4  error or stuck        → <ParseTerminalView variant="error" kind={error|stuck}>
 *   5  mismatch              → <ParseTerminalView variant="mismatch">
 *   6  year_rollover         → <ParseTerminalView variant="year_rollover">
 *   7  canonical_match       → <ParseTerminalView variant="canonical_match">
 *   8  complete (plan_doc)   → <ParseTerminalView variant="complete_plan">
 *   9  complete (bill)       → <ParseTerminalView variant="complete_bill">
 *  10  active (catch-all)    → <UnifiedParseScreen>
 *
 * Why this order: modal at priority 0 — beats every loader. Closes the S99
 * bug at the structural level (impossible for any loader to pre-empt when
 * state class is awaiting_confirmation). Order of states 5-7 matches the
 * existing inline derivation predicates (mismatch wins over year_rollover
 * wins over canonical_match per upload/page.tsx:848-854 `!mismatch` /
 * `!hasYearRollover` exclusions).
 *
 * State derivation (isComplete, hasMismatch, etc.) + playfulFloorActive (S71
 * 4s minimum-display floor) + phase derivation all happen INTERNALLY here.
 * Caller (UploadForm) passes only raw inputs + callbacks.
 *
 * Cross-reference: plans/s100_processing_flow_refactor §3.2 dispatch
 * precedence table.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { DocTypeConfirmationModal } from "./DocTypeConfirmationModal";
import { ParseTerminalView, type InsurerMismatchData, type YearRolloverData, type CanonicalMatchData } from "./ParseTerminalView";
import { UnifiedParseScreen, derivePhase, type ParseDoc } from "./UnifiedParseScreen";
import type { DocType, DocTypeConfirmation } from "@/lib/classifier/doc-type-vocabulary";
import { getExpectedDurationCopy } from "@/lib/parsing/parseProgressUx";

type UploadStatus =
  | "uploading"
  | "uploaded"
  | "auto_processed"
  | "pending_review"
  | "rejected"
  | "dedup_processed"
  | "awaiting_confirmation"
  | null;

interface InsurerMismatchPayload {
  mismatch?: boolean;
  type?: "insurer" | "plan_name";
  existingInsurer?: string;
  parsedInsurer?: string;
  existingPlanName?: string;
  parsedPlanName?: string;
  pending_canonical_match?: {
    canonicalPlanId: string;
    matchedPlanName: string;
    confidence: number;
    sourceCount: number;
    insurerName: string;
  };
  year_rollover?: {
    currentYear: number;
    newYear: number;
  };
}

interface ProcessingProgress {
  status: string;
  step: string | null;
  completedPages: number;
  totalPages: number;
  insurerMismatch?: InsurerMismatchPayload | null;
  processingError?: string | null;
  retryCount?: number;
  isStuck?: boolean;
  linkedInsurancePlanId?: string | null;
  linkedPlanPremium?: number | null;
  /**
   * S102 — surfaces documents.metadata.smart_skip_outcome from the status
   * endpoint. "skipped" when backend smart-skipped Haiku parse; null otherwise.
   * Used by UnifiedParseScreen to accelerate page-tick + sub-phase intervals.
   */
  smartSkipOutcome?: string | null;
}

interface ClassificationResult {
  classifiedType: string;
  confidence: number;
  mismatch: boolean;
}

export interface ProcessingFlowProps {
  // Identity
  documentId: string | null;
  fileName: string;
  docType: DocType;
  user: { firebaseUser: { getIdToken(): Promise<string> }; userId: string } | null;

  // Upload-tier state
  uploaded: boolean;
  uploadStatus: UploadStatus;
  uploadProgress: number;
  confirmationData: DocTypeConfirmation | null;

  // Processing state (from polling)
  processingProgress: ProcessingProgress | null;
  classificationResult: ClassificationResult | null;
  isLargeDoc: boolean;
  largeDocPageCount: number | null;
  yearRolloverEnabled: boolean;
  premiumSaved: boolean;
  retrying: boolean;

  // Callbacks (parent owns state mutation + API calls)
  onCancelInFlight: () => void;
  onUploadAnother: () => void;
  onConfirmDocType: (confirmedDocType: DocType) => Promise<void>;
  onCancelConfirmation: () => Promise<void>;
  onUseThisPlanFromMismatch: () => Promise<void>;
  onKeepCurrentFromMismatch: () => Promise<void>;
  onSwitchYearRollover: () => Promise<void>;
  onKeepCurrentYearRollover: () => Promise<void>;
  onConfirmCanonicalMatch: () => Promise<void>;
  onRejectCanonicalMatch: () => Promise<void>;
  onRetryDocument: () => Promise<void>;
  onPremiumSaved: (amount: number) => void;
  onPremiumSkipped: () => void;
  /**
   * S101 v3 — fires once the internal sub-phase machine has fully played out
   * (every doc reached subPhase "complete"). Parent uses this to gate the
   * auto-redirect that lives in upload/page.tsx's polling effect — without
   * this signal, the redirect would race the sub-phase machine and navigate
   * away before the user sees "Finalizing Parse / Syncing to Profile / Final
   * Steps".
   */
  onProgressionComplete?: () => void;
}

// Minimum-display floor for the parsing screen (S71 hotfix). Smart-skip
// re-uploads complete in 1-3s end-to-end; floor ensures every user sees the
// playful animation even on fast paths.
//
// S101 v2 — the floor is now mostly superseded by the sub-phase machine's
// own minimum duration (~6N + 45s before final_steps). The floor is still
// kept for the brief window between upload-complete and totalPages seed.
const MIN_PLAYFUL_MS = 4000;

export function ProcessingFlow(props: ProcessingFlowProps) {
  const {
    documentId,
    fileName,
    docType,
    user,
    uploaded,
    uploadStatus,
    uploadProgress,
    confirmationData,
    processingProgress,
    isLargeDoc,
    largeDocPageCount,
    yearRolloverEnabled,
    premiumSaved,
    retrying,
    classificationResult,
  } = props;

  // ─── Derived predicates (mirrors upload/page.tsx:845-895 + 305-332) ────
  const isPendingReview = uploadStatus === "pending_review";
  const isUploading = uploadStatus === "uploading";
  const isComplete =
    processingProgress?.status === "processed" &&
    !processingProgress?.insurerMismatch?.mismatch &&
    !(yearRolloverEnabled && processingProgress?.insurerMismatch?.year_rollover) &&
    !processingProgress?.insurerMismatch?.pending_canonical_match;
  const isError = processingProgress?.status === "error";
  const isStuck = !!processingProgress?.isStuck;
  const canRetry = (isError || isStuck) && (processingProgress?.retryCount ?? 0) < 3;
  const hasMismatch =
    processingProgress?.status === "processed" && !!processingProgress?.insurerMismatch?.mismatch;
  const hasYearRollover =
    yearRolloverEnabled &&
    processingProgress?.status === "processed" &&
    !processingProgress?.insurerMismatch?.mismatch &&
    !!processingProgress?.insurerMismatch?.year_rollover;
  const hasCanonicalMatch =
    processingProgress?.status === "processed" &&
    !processingProgress?.insurerMismatch?.mismatch &&
    !hasYearRollover &&
    !!processingProgress?.insurerMismatch?.pending_canonical_match;
  const isPlanType = docType === "sbc" || docType === "plan_document";
  const isBillType = docType === "eob" || docType === "itemized_bill";
  const needsPremium =
    isPlanType &&
    processingProgress?.status === "processed" &&
    processingProgress?.linkedPlanPremium == null &&
    !premiumSaved;

  // inActiveProcessing: doc is mid-flight (not yet hit any terminal state).
  // Drives the UnifiedParseScreen render at priority 10.
  const inActiveProcessing =
    uploaded &&
    !isComplete &&
    !isError &&
    !isStuck &&
    !hasMismatch &&
    !hasYearRollover &&
    !hasCanonicalMatch &&
    !isPendingReview;

  // ─── Playful floor lifecycle (S71 4s minimum-display floor) ────────────
  // Mirrors upload/page.tsx:301-368 verbatim — single effect orchestrates
  // engage / bypass / release-after-delay. setState calls inside the effect
  // body sync state to derived terminal/active conditions; the delayed-release
  // setState lives inside a setTimeout callback (the rule's intended escape
  // hatch for timer-driven state updates).
  const [playfulFloorActive, setPlayfulFloorActive] = useState(false);
  const playfulShownAtRef = useRef<number | null>(null);

  const inTerminalState = isError || isStuck || hasMismatch || hasCanonicalMatch || hasYearRollover;

  useEffect(() => {
    if (!uploaded) {
      if (playfulFloorActive) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors upload/page.tsx S91 floor lifecycle; ref-guarded so no cascade
        setPlayfulFloorActive(false);
      }
      playfulShownAtRef.current = null;
      return;
    }

    // Terminal states bypass the floor — surface immediately so the user can act.
    if (inTerminalState) {
      if (playfulFloorActive) {
        setPlayfulFloorActive(false);
        playfulShownAtRef.current = null;
      }
      return;
    }

    // Engage floor on first active state of this upload session.
    if (inActiveProcessing && playfulShownAtRef.current === null) {
      playfulShownAtRef.current = Date.now();
      setPlayfulFloorActive(true);
      return;
    }

    // Schedule floor release when active state ends + min window elapses.
    if (!inActiveProcessing && playfulFloorActive && playfulShownAtRef.current !== null) {
      const elapsed = Date.now() - playfulShownAtRef.current;
      const remaining = MIN_PLAYFUL_MS - elapsed;
      if (remaining <= 0) {
        setPlayfulFloorActive(false);
        playfulShownAtRef.current = null;
        return;
      }
      const t = setTimeout(() => {
        setPlayfulFloorActive(false);
        playfulShownAtRef.current = null;
      }, remaining);
      return () => clearTimeout(t);
    }
  }, [uploaded, inTerminalState, inActiveProcessing, playfulFloorActive]);

  // ─── Progression-complete gate (S101 v2 — Andrew direction) ──────────
  //
  // The user must see the full sub-phase progression even when the backend
  // finishes fast. UnifiedParseScreen owns the sub-phase machine + fires
  // onProgressionComplete once it's wrapped up (all docs at subPhase
  // "complete"). Until then, ProcessingFlow stays at priority 10 (rendering
  // UnifiedParseScreen) even after isComplete flips.
  //
  // Reset on documentId change uses the during-render setState-with-guard
  // pattern (React 19 idiom for prop-derived state resets) — same shape as
  // useSyntheticDisplayedPage's totalPages reset. Parent (UploadForm) already
  // unmounts/remounts ProcessingFlow via the `if (uploaded)` gate when
  // starting a new upload, so this guard is mostly a belt-and-suspenders
  // defense against a documentId change without an unmount (retryDocument
  // reuses the same instance).
  const [progressionComplete, setProgressionComplete] = useState(false);
  const [lastDocumentId, setLastDocumentId] = useState(documentId);
  if (documentId !== lastDocumentId) {
    setLastDocumentId(documentId);
    setProgressionComplete(false);
  }
  const handleProgressionComplete = useCallback(() => {
    setProgressionComplete(true);
    props.onProgressionComplete?.();
  }, [props]);

  // ─── Priority dispatch ────────────────────────────────────────────────

  // Priority 0 — Modal (S99 bug closed at the structural level)
  if (uploadStatus === "awaiting_confirmation" && confirmationData && documentId) {
    return (
      <DocTypeConfirmationModal
        confirmationData={confirmationData}
        onConfirmDocType={props.onConfirmDocType}
        onCancel={props.onCancelConfirmation}
      />
    );
  }

  // Priorities 1-2 — Unusable
  if (uploadStatus === "pending_review") {
    return (
      <ParseTerminalView
        variant="unusable"
        kind="pending_review"
        fileName={fileName}
        onUploadAnother={props.onUploadAnother}
      />
    );
  }
  if (uploadStatus === "rejected") {
    return (
      <ParseTerminalView
        variant="unusable"
        kind="rejected"
        fileName={fileName}
        onUploadAnother={props.onUploadAnother}
      />
    );
  }

  // Priority 3 — Dedup of already-processed (brief splash)
  if (uploadStatus === "dedup_processed") {
    return (
      <ParseTerminalView
        variant="dedup_processed"
        fileName={fileName}
        onUploadAnother={props.onUploadAnother}
      />
    );
  }

  // Priority 4 — Error or stuck
  if (isError || isStuck) {
    return (
      <ParseTerminalView
        variant="error"
        kind={isStuck ? "stuck" : "error"}
        canRetry={canRetry}
        retrying={retrying}
        onRetry={props.onRetryDocument}
        fileName={fileName}
        onUploadAnother={props.onUploadAnother}
      />
    );
  }

  // Priority 5 — Mismatch
  if (hasMismatch && processingProgress?.insurerMismatch) {
    const mm = processingProgress.insurerMismatch;
    const mismatchData: InsurerMismatchData = {
      type: mm.type,
      existingInsurer: mm.existingInsurer,
      parsedInsurer: mm.parsedInsurer,
      existingPlanName: mm.existingPlanName,
      parsedPlanName: mm.parsedPlanName,
    };
    return (
      <ParseTerminalView
        variant="mismatch"
        mismatch={mismatchData}
        submitting={false}
        onUseThisPlan={props.onUseThisPlanFromMismatch}
        onKeepCurrent={props.onKeepCurrentFromMismatch}
        fileName={fileName}
        onUploadAnother={props.onUploadAnother}
      />
    );
  }

  // Priority 6 — Year rollover
  if (hasYearRollover && processingProgress?.insurerMismatch?.year_rollover) {
    const yr: YearRolloverData = processingProgress.insurerMismatch.year_rollover;
    return (
      <ParseTerminalView
        variant="year_rollover"
        yearRollover={yr}
        submitting={false}
        onSwitchYear={props.onSwitchYearRollover}
        onKeepCurrent={props.onKeepCurrentYearRollover}
        fileName={fileName}
        onUploadAnother={props.onUploadAnother}
      />
    );
  }

  // Priority 7 — Canonical match
  if (hasCanonicalMatch && processingProgress?.insurerMismatch?.pending_canonical_match) {
    const cm: CanonicalMatchData = processingProgress.insurerMismatch.pending_canonical_match;
    return (
      <ParseTerminalView
        variant="canonical_match"
        canonicalMatch={cm}
        submitting={false}
        onConfirmMatch={props.onConfirmCanonicalMatch}
        onRejectMatch={props.onRejectCanonicalMatch}
        fileName={fileName}
        onUploadAnother={props.onUploadAnother}
      />
    );
  }

  // Priority 8 — Complete (plan-doc family). S101 v2 gate: progressionComplete
  // must also be true so the user sees the full sub-phase machine play out
  // before transitioning to the terminal view.
  if (isComplete && isPlanType && progressionComplete) {
    const showSupplementPrompt = !!(classificationResult && classificationResult.confidence < 0.8);
    return (
      <ParseTerminalView
        variant="complete_plan"
        needsPremium={!!needsPremium}
        linkedInsurancePlanId={processingProgress?.linkedInsurancePlanId ?? null}
        user={user}
        premiumSaved={premiumSaved}
        showSupplementPrompt={showSupplementPrompt}
        onPremiumSaved={props.onPremiumSaved}
        onPremiumSkipped={props.onPremiumSkipped}
        fileName={fileName}
        onUploadAnother={props.onUploadAnother}
      />
    );
  }

  // Priority 9 — Complete (bill family). Same gate as priority 8.
  if (isComplete && isBillType && progressionComplete) {
    const showSupplementPrompt = !!(
      classificationResult &&
      classificationResult.confidence < 0.8 &&
      classificationResult.confidence >= 0.6
    );
    return (
      <ParseTerminalView
        variant="complete_bill"
        docType={docType as "eob" | "itemized_bill"}
        showSupplementPrompt={showSupplementPrompt}
        fileName={fileName}
        onUploadAnother={props.onUploadAnother}
      />
    );
  }

  // Priority 10 — Active (catch-all)
  const phase = derivePhase({ uploadStatus, processingProgress, uploadProgress });

  const doc: ParseDoc = {
    id: documentId ?? "single",
    label: "Your document",
    fileName: fileName || "document.pdf",
    phase,
    uploadProgress,
    totalPages: processingProgress?.totalPages ?? null,
    step: processingProgress?.step ?? null,
    realCompletedPages: processingProgress?.completedPages ?? null,
    smartSkipOutcome: processingProgress?.smartSkipOutcome ?? null,
  };

  // Universal loader title + subtitle (Andrew direction S101). The two-flow
  // model says the screen looks the same whether we're still in the upload
  // window or already ticking pages — only the pill + status text differ
  // inside the doc card. Title stays "Reading your document" across the whole
  // pre-complete window. Large-doc async-UX keeps its specific copy
  // (async_ingestion_ux_v1 flag is global ON in PROD) — it's a meaningfully
  // different UX (the email-on-complete promise) and pre-launch isn't tied
  // to phase.
  const title = isLargeDoc ? "Thanks — we're reading your plan" : "Reading your document";
  const subtitle = isLargeDoc
    ? (() => {
        const pages = largeDocPageCount ?? 0;
        const pagesPhrase = pages > 0 ? `${pages} pages of` : "";
        const largeDocDuration = getExpectedDurationCopy(docType, pages);
        return `${pagesPhrase ? pagesPhrase + " " : ""}careful extraction takes about ${largeDocDuration}. Hang tight, browse the rest of Candid, or close the tab — we'll email you the moment it's ready.`;
      })()
    : "We meticulously go over every detail in your plan not once but twice. That takes a while, but we know it's worth it.";
  // Suppress unused-var warning while we keep playful-floor for re-use elsewhere.
  void playfulFloorActive;

  // Large-doc footer: optional "browse Candid" CTA.
  const footer = isLargeDoc ? (
    <div className="text-center">
      <a
        href="/dashboard"
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium transition-colors"
      >
        Browse Candid while we work
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </a>
      <p className="text-xs text-slate-500 mt-3">
        You can leave this tab. We&rsquo;ll email when your plan is ready.
      </p>
    </div>
  ) : undefined;

  return (
    <UnifiedParseScreen
      docs={[doc]}
      title={title}
      subtitle={subtitle}
      footer={footer}
      onCancel={props.onCancelInFlight}
      onProgressionComplete={handleProgressionComplete}
    />
  );
}
