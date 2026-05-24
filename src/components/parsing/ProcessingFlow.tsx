"use client";

/**
 * ProcessingFlow — single deterministic dispatcher for the /upload post-upload
 * UX (S100 structural fix).
 *
 * B2-UP.1 refactor (Andrew direction at S119 → S120): split into
 *   - `useProcessingFlowSlots` hook — emits {modal, dropZoneContent,
 *     belowDropZone, hidePathsGrid, isComplete} based on the 11-priority
 *     dispatch. Used by upload/page.tsx so the new design layout (header +
 *     type picker + drop-zone container + paths grid + share) can route
 *     content into the right visual slots per D-§1.B.1-E.
 *   - `ProcessingFlow` component — backward-compatible wrapper that renders
 *     whichever slot is non-null in full-screen, matching pre-B2-UP.1 behavior.
 *
 * Priority-ordered dispatch (first match wins; UNCHANGED from S100):
 *
 *   0  awaiting_confirmation → DocTypeConfirmationModal           [modal slot]
 *   1  pending_review        → ParseTerminalView unusable          [drop zone]
 *   2  rejected              → ParseTerminalView unusable          [drop zone]
 *   3  dedup_processed       → ParseTerminalView dedup_processed   [drop zone]
 *   4  error or stuck        → ParseTerminalView error             [drop zone]
 *   5  mismatch              → ParseTerminalView mismatch          [below DZ]
 *   6  year_rollover         → ParseTerminalView year_rollover     [below DZ]
 *   7  canonical_match       → ParseTerminalView canonical_match   [below DZ]
 *   8  complete (plan_doc)   → DropDone OR ParseTerminalView       [drop zone]
 *   9  complete (bill)       → DropDone OR ParseTerminalView       [drop zone]
 *  10  active (catch-all)    → UnifiedParseScreen                  [drop zone]
 *
 * Priorities 5-7 (heavy interactive forms) render BELOW the drop zone per
 * D-§1.B.1-E — multi-field forms don't fit drop-zone height. All other
 * non-modal priorities render INSIDE the drop-zone container.
 *
 * State derivation (isComplete, hasMismatch, etc.) + playfulFloorActive (S71
 * 4s minimum-display floor) + progression-complete gate all happen INTERNALLY
 * here. Caller (UploadForm) passes raw inputs + callbacks.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DocTypeConfirmationModal } from "./DocTypeConfirmationModal";
import { ParseTerminalView, type InsurerMismatchData, type YearRolloverData, type CanonicalMatchData } from "./ParseTerminalView";
import { UnifiedParseScreen, derivePhase, type ParseDoc } from "./UnifiedParseScreen";
import { DropDone } from "@/components/upload/DropZoneStates";
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

  /**
   * B2-UP.1 — loader visual variant passed through to UnifiedParseScreen +
   * gates the DropDone happy-path completion visual at priorities 8-9.
   * Default "default" preserves legacy doc-card visual; "stackV3" enables
   * the design's StackLoaderV3 + DropDone chrome for the new /upload layout.
   */
  loaderVariant?: "default" | "stackV3";

  /**
   * B2-UP.1 — destination for the DropDone "See the findings" / "View your
   * benefits" CTA at priorities 8-9 (stackV3 only). Caller wires to
   * window.location.href or router.push.
   */
  onViewResults?: () => void;
}

export interface ProcessingFlowSlots {
  modal: ReactNode | null;
  dropZoneContent: ReactNode | null;
  belowDropZone: ReactNode | null;
  /**
   * Whether the "Paths" grid below the drop zone should be hidden (D-§1.B.1-D
   * — focus during processing + exceptions; visible idle + done).
   */
  hidePathsGrid: boolean;
  /**
   * Whether the sub-phase machine has fully resolved AND backend signaled
   * processed (priorities 8-9 active). Caller can show post-complete chrome.
   */
  isComplete: boolean;
}

// Minimum-display floor for the parsing screen (S71 hotfix). Smart-skip
// re-uploads complete in 1-3s end-to-end; floor ensures every user sees the
// playful animation even on fast paths.
//
// S101 v2 — the floor is now mostly superseded by the sub-phase machine's
// own minimum duration (~6N + 45s before final_steps). The floor is still
// kept for the brief window between upload-complete and totalPages seed.
const MIN_PLAYFUL_MS = 4000;

export function useProcessingFlowSlots(props: ProcessingFlowProps): ProcessingFlowSlots {
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
    loaderVariant = "default",
    onViewResults,
  } = props;

  // ─── Derived predicates (mirrors upload/page.tsx:845-895 + 305-332) ────
  const isPendingReview = uploadStatus === "pending_review";
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

    if (inTerminalState) {
      if (playfulFloorActive) {
        setPlayfulFloorActive(false);
        playfulShownAtRef.current = null;
      }
      return;
    }

    if (inActiveProcessing && playfulShownAtRef.current === null) {
      playfulShownAtRef.current = Date.now();
      setPlayfulFloorActive(true);
      return;
    }

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

  // Suppress unused-var warning while we keep playful-floor for re-use elsewhere.
  void playfulFloorActive;

  // ─── Slot dispatch (matches the 11-priority precedence table verbatim) ─
  const slots: ProcessingFlowSlots = {
    modal: null,
    dropZoneContent: null,
    belowDropZone: null,
    hidePathsGrid: true,
    isComplete: false,
  };

  // B2-UP.1 — when uploaded=false, the /upload page renders DropIdle / hover
  // / uploading content itself; ProcessingFlow has no slots to emit. Guard
  // prevents the priority-10 catch-all from rendering UnifiedParseScreen
  // during the idle form (pre-upload).
  if (!uploaded) {
    slots.hidePathsGrid = false; // paths grid visible during idle
    return slots;
  }

  // Priority 0 — Modal (S99 bug closed at the structural level)
  if (uploadStatus === "awaiting_confirmation" && confirmationData && documentId) {
    slots.modal = (
      <DocTypeConfirmationModal
        confirmationData={confirmationData}
        onConfirmDocType={props.onConfirmDocType}
        onCancel={props.onCancelConfirmation}
      />
    );
    return slots;
  }

  // Priorities 1-2 — Unusable (in drop zone)
  if (uploadStatus === "pending_review") {
    slots.dropZoneContent = (
      <ParseTerminalView
        variant="unusable"
        kind="pending_review"
        fileName={fileName}
        onUploadAnother={props.onUploadAnother}
      />
    );
    return slots;
  }
  if (uploadStatus === "rejected") {
    slots.dropZoneContent = (
      <ParseTerminalView
        variant="unusable"
        kind="rejected"
        fileName={fileName}
        onUploadAnother={props.onUploadAnother}
      />
    );
    return slots;
  }

  // Priority 3 — Dedup of already-processed (in drop zone)
  if (uploadStatus === "dedup_processed") {
    slots.dropZoneContent = (
      <ParseTerminalView
        variant="dedup_processed"
        fileName={fileName}
        onUploadAnother={props.onUploadAnother}
      />
    );
    return slots;
  }

  // Priority 4 — Error or stuck (in drop zone)
  if (isError || isStuck) {
    slots.dropZoneContent = (
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
    return slots;
  }

  // Priority 5 — Mismatch (BELOW drop zone — heavy interactive form)
  if (hasMismatch && processingProgress?.insurerMismatch) {
    const mm = processingProgress.insurerMismatch;
    const mismatchData: InsurerMismatchData = {
      type: mm.type,
      existingInsurer: mm.existingInsurer,
      parsedInsurer: mm.parsedInsurer,
      existingPlanName: mm.existingPlanName,
      parsedPlanName: mm.parsedPlanName,
    };
    slots.belowDropZone = (
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
    return slots;
  }

  // Priority 6 — Year rollover (BELOW drop zone)
  if (hasYearRollover && processingProgress?.insurerMismatch?.year_rollover) {
    const yr: YearRolloverData = processingProgress.insurerMismatch.year_rollover;
    slots.belowDropZone = (
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
    return slots;
  }

  // Priority 7 — Canonical match (BELOW drop zone)
  if (hasCanonicalMatch && processingProgress?.insurerMismatch?.pending_canonical_match) {
    const cm: CanonicalMatchData = processingProgress.insurerMismatch.pending_canonical_match;
    slots.belowDropZone = (
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
    return slots;
  }

  // Priority 8 — Complete (plan-doc family). S101 v2 gate: progressionComplete
  // must also be true so the user sees the full sub-phase machine play out
  // before transitioning to the terminal view.
  if (isComplete && isPlanType && progressionComplete) {
    const showSupplementPrompt = !!(classificationResult && classificationResult.confidence < 0.8);
    // DropDone happy-path visual ONLY when stackV3 variant AND no premium/supplement prompts.
    if (loaderVariant === "stackV3" && !needsPremium && !showSupplementPrompt && onViewResults) {
      slots.dropZoneContent = (
        <DropDone
          kind="plan"
          fileName={fileName}
          onUploadAnother={props.onUploadAnother}
          onViewResults={onViewResults}
        />
      );
    } else {
      slots.dropZoneContent = (
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
    slots.hidePathsGrid = false; // paths grid visible during "done" state
    slots.isComplete = true;
    return slots;
  }

  // Priority 9 — Complete (bill family). Same gate as priority 8.
  if (isComplete && isBillType && progressionComplete) {
    const showSupplementPrompt = !!(
      classificationResult &&
      classificationResult.confidence < 0.8 &&
      classificationResult.confidence >= 0.6
    );
    if (loaderVariant === "stackV3" && !showSupplementPrompt && onViewResults) {
      slots.dropZoneContent = (
        <DropDone
          kind="bill"
          fileName={fileName}
          onUploadAnother={props.onUploadAnother}
          onViewResults={onViewResults}
        />
      );
    } else {
      slots.dropZoneContent = (
        <ParseTerminalView
          variant="complete_bill"
          docType={docType as "eob" | "itemized_bill"}
          showSupplementPrompt={showSupplementPrompt}
          fileName={fileName}
          onUploadAnother={props.onUploadAnother}
        />
      );
    }
    slots.hidePathsGrid = false; // paths grid visible during "done" state
    slots.isComplete = true;
    return slots;
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

  // Universal loader title + subtitle (Andrew direction S101).
  const title = isLargeDoc ? "Thanks — we're reading your plan" : "Reading your document";
  const subtitle = isLargeDoc
    ? (() => {
        const pages = largeDocPageCount ?? 0;
        const pagesPhrase = pages > 0 ? `${pages} pages of` : "";
        const largeDocDuration = getExpectedDurationCopy(docType, pages);
        return `${pagesPhrase ? pagesPhrase + " " : ""}careful extraction takes about ${largeDocDuration}. Hang tight, browse the rest of Candid, or close the tab — we'll email you the moment it's ready.`;
      })()
    : "We meticulously go over every detail in your plan not once but twice. That takes a while, but we know it's worth it.";

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

  slots.dropZoneContent = (
    <UnifiedParseScreen
      docs={[doc]}
      title={title}
      subtitle={subtitle}
      footer={footer}
      onCancel={props.onCancelInFlight}
      onProgressionComplete={handleProgressionComplete}
      loaderVariant={loaderVariant}
    />
  );
  return slots;
}

/**
 * Backward-compatible wrapper. Renders whichever slot is non-null in
 * full-screen — pre-B2-UP.1 behavior. New /upload page uses the hook
 * directly + routes slots into the new design layout.
 */
export function ProcessingFlow(props: ProcessingFlowProps) {
  const slots = useProcessingFlowSlots(props);
  if (slots.modal) return slots.modal;
  if (slots.dropZoneContent) return slots.dropZoneContent;
  if (slots.belowDropZone) return slots.belowDropZone;
  return null;
}
