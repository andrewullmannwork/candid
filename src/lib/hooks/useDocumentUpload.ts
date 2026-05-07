"use client";

/**
 * useDocumentUpload — shared client-side upload primitive.
 *
 * Extracts /upload's proven upload flow (XHR + Turnstile + polling + consent)
 * into a single hook used by both /upload and /compare's per-slot upload mode.
 *
 * Why this exists: Session 70 shipped /compare with its own per-slot upload
 * implementation (PlanSlot.tsx). Across 4 PRs (#49 → #50 → #51 → #52) it
 * accumulated client-side bugs (display:none widget, mode-transition unmount,
 * filename-match polling) that /upload doesn't have. CF-30 collapses both
 * surfaces onto one primitive so divergence becomes structurally impossible.
 *
 * See plans/cf30_use_document_upload_hook.md for full context.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { useConsent } from "@/lib/consent/use-consent";
import {
  TurnstileWidget,
  type TurnstileWidgetHandle,
} from "@/components/security/TurnstileWidget";

// ─── Types ──────────────────────────────────────────────────────────────────

export type DocType = "eob" | "itemized_bill" | "sbc" | "plan_document";

export type UploadStatus =
  | "idle"
  | "uploading"
  | "uploaded"
  | "auto_processed"
  | "pending_review"
  | "rejected"
  | "processed"
  | "error";

export interface InsurerMismatch {
  mismatch: boolean;
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
  year_rollover?: { currentYear: number; newYear: number };
}

export interface ProcessingProgress {
  status: string;
  step: string | null;
  completedPages: number;
  totalPages: number;
  insurerMismatch?: InsurerMismatch | null;
  processingError?: string | null;
  retryCount?: number;
  isStuck?: boolean;
  needsTrigger?: boolean;
}

export interface UploadClassification {
  classifiedType: string;
  confidence: number;
  mismatch: boolean;
}

/**
 * Final result of a doUpload() call. Resolves when polling reaches a terminal
 * state (processed | pending_review | rejected | uploaded). Promise rejects on
 * upload-time error, processing error, stuck doc, or poll-timeout.
 */
export interface UploadResult {
  documentId: string;
  status: UploadStatus;
  classification?: UploadClassification;
  processingProgress?: ProcessingProgress;
  /** Populated for plan docs when resolveInsurancePlanId option is provided. */
  insurancePlanId?: string;
  rejected?: { message: string };
}

export interface UseDocumentUploadOptions {
  /** Default document type; overridable per-call via doUpload(file, { docType }). */
  defaultDocType: DocType;
  /** Polling cadence in ms. Default 4000 (4s) — matches /upload baseline. */
  pollIntervalMs?: number;
  /** Max polling attempts before promise rejects with "stuck" reason. Default 75 (5 min @ 4s). */
  pollMaxAttempts?: number;
  /**
   * Optional: caller-supplied resolver to look up the insurance_plan_id linked
   * to the processed document (compare uses this; /upload doesn't need it
   * because it redirects to /plan which loads its own plan data).
   */
  resolveInsurancePlanId?: (documentId: string) => Promise<string | null>;
}

export interface UseDocumentUploadReturn {
  // Upload state
  uploading: boolean;
  uploaded: boolean;
  uploadStatus: UploadStatus;
  uploadProgress: number;
  documentId: string | null;
  processingProgress: ProcessingProgress | null;
  classification: UploadClassification | null;
  fileName: string;
  error: string;
  /** Caller can set/clear the displayed error (e.g., for client-side file-type or size validation before doUpload). */
  setError: (e: string) => void;

  // Turnstile (caller renders <TurnstileWidget> with these)
  turnstileToken: string | null;
  setTurnstileToken: (t: string | null) => void;
  turnstileRef: RefObject<TurnstileWidgetHandle | null>;

  // Consent (caller renders modal JSX; hook owns state + flow)
  hasConsented: boolean;
  consentLoading: boolean;
  consentChecked: boolean;
  setConsentChecked: (b: boolean) => void;
  showConsentModal: boolean;
  pendingFile: File | null;
  openConsentModal: (file: File) => void;
  closeConsentModal: () => void;
  /** Records consent only (no upload). Caller composes after when a custom flow is needed (e.g., /compare's inline-prompt-then-loop pattern). */
  grantConsent: () => Promise<void>;
  /** Records consent + uploads pendingFile. Convenience for the modal-pattern (/upload). */
  grantConsentAndUpload: () => Promise<void>;

  // Actions
  doUpload: (file: File, opts?: { docType?: DocType }) => Promise<UploadResult>;
  reset: () => void;
  /**
   * Resume polling for an already-uploaded document (e.g., after the caller
   * triggers /api/documents/reprocess on a stuck/failed doc). Sets the hook's
   * internal state so the polling effect picks up the new documentId without
   * going through doUpload's XHR flow.
   */
  resumePolling: (documentId: string) => void;
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useDocumentUpload(
  options: UseDocumentUploadOptions
): UseDocumentUploadReturn {
  const { user } = useAuth();
  const {
    defaultDocType,
    pollIntervalMs = 4000,
    pollMaxAttempts = 75,
    resolveInsurancePlanId,
  } = options;

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [classification, setClassification] =
    useState<UploadClassification | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [processingProgress, setProcessingProgress] =
    useState<ProcessingProgress | null>(null);

  // Turnstile state
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);

  // Consent state — hook owns lifecycle; caller renders modal JSX
  const {
    hasConsented,
    loading: consentLoading,
    grantConsent,
  } = useConsent("health_data_upload");
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  // Promise resolver for the in-flight doUpload() call. The polling effect
  // resolves/rejects this when it reaches a terminal state, so the caller's
  // `await doUpload(file)` resolves with the final result.
  const promiseResolverRef = useRef<{
    resolve: (r: UploadResult) => void;
    reject: (e: Error) => void;
  } | null>(null);

  // Refs for values used inside the polling effect that shouldn't trigger
  // effect restarts when they change.
  const classificationRef = useRef<UploadClassification | null>(null);
  classificationRef.current = classification;
  const resolveInsurancePlanIdRef = useRef(resolveInsurancePlanId);
  resolveInsurancePlanIdRef.current = resolveInsurancePlanId;

  // ─── Polling effect (ports /upload/page.tsx:192-247) ─────────────────────
  useEffect(() => {
    if (!documentId || uploadStatus !== "auto_processed") return;

    let active = true;
    let attempts = 0;
    const poll = async () => {
      try {
        const res = await fetch(`/api/documents/status?id=${documentId}`);
        if (!res.ok || !active) return;
        const data: ProcessingProgress = await res.json();
        setProcessingProgress(data);
        attempts++;

        if (data.status === "processed") {
          active = false;
          setUploadStatus("processed");
          // Resolve the in-flight doUpload Promise with final state.
          // /upload's old code redirected here based on docType; the hook
          // doesn't redirect — caller decides what to do with the result.
          let insurancePlanId: string | undefined;
          if (resolveInsurancePlanIdRef.current) {
            try {
              const id = await resolveInsurancePlanIdRef.current(documentId);
              if (id) insurancePlanId = id;
            } catch {
              // Non-fatal; caller can re-resolve from documentId if needed.
            }
          }
          promiseResolverRef.current?.resolve({
            documentId,
            status: "processed",
            classification: classificationRef.current ?? undefined,
            processingProgress: data,
            insurancePlanId,
          });
          promiseResolverRef.current = null;
          return;
        }

        if (data.status === "pending_review") {
          active = false;
          setUploadStatus("pending_review");
          promiseResolverRef.current?.resolve({
            documentId,
            status: "pending_review",
            classification: classificationRef.current ?? undefined,
            processingProgress: data,
          });
          promiseResolverRef.current = null;
          return;
        }

        if (data.status === "error" || data.isStuck) {
          active = false;
          setUploadStatus("error");
          const errMsg =
            data.processingError ||
            (data.isStuck
              ? "Document stuck. Click retry to resume."
              : "Document processing error");
          setError(errMsg);
          promiseResolverRef.current?.reject(new Error(errMsg));
          promiseResolverRef.current = null;
          return;
        }

        if (attempts >= pollMaxAttempts) {
          active = false;
          const errMsg =
            "Processing taking longer than expected. Check back later.";
          setError(errMsg);
          promiseResolverRef.current?.reject(new Error(errMsg));
          promiseResolverRef.current = null;
          return;
        }

        // Trigger next chunk if needed (for multi-page docs)
        if (data.needsTrigger) {
          await fetch("/api/documents/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ documentId }),
          });
        }
      } catch {
        // Silently retry on next interval
      }
    };

    // Start immediately, then poll every pollIntervalMs
    poll();
    const interval = setInterval(poll, pollIntervalMs);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [documentId, uploadStatus, pollIntervalMs, pollMaxAttempts]);

  // ─── doUpload (ports /upload/page.tsx:272-368) ───────────────────────────
  const doUpload = useCallback(
    async (
      file: File,
      opts?: { docType?: DocType }
    ): Promise<UploadResult> => {
      if (!user) throw new Error("Authentication required");
      const docType = opts?.docType ?? defaultDocType;

      setUploading(true);
      setUploaded(true); // Immediately show progress UI
      setUploadStatus("uploading");
      setError("");
      setFileName(file.name);
      setUploadProgress(0);
      setProcessingProgress(null);
      setDocumentId(null);

      try {
        const idToken = await user.firebaseUser.getIdToken();

        // Build FormData (file + docType + turnstileToken)
        const formData = new FormData();
        formData.append("file", file);
        formData.append("docType", docType);
        if (turnstileToken) formData.append("turnstileToken", turnstileToken);

        // XHR for upload progress tracking
        const res = await new Promise<Response>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.addEventListener("progress", (e) => {
            if (e.lengthComputable) {
              setUploadProgress(Math.round((e.loaded / e.total) * 100));
            }
          });
          xhr.addEventListener("load", () => {
            resolve(
              new Response(xhr.responseText, {
                status: xhr.status,
                headers: { "content-type": "application/json" },
              })
            );
          });
          xhr.addEventListener("error", () =>
            reject(new Error("Upload failed"))
          );
          xhr.open("POST", "/api/documents/upload");
          xhr.setRequestHeader("Authorization", `Bearer ${idToken}`);
          xhr.send(formData);
        });

        // Reset Turnstile so the next upload gets a fresh token (single-use)
        turnstileRef.current?.reset();

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          let errMsg: string;
          if (res.status === 403 && errBody.error?.includes("Bot defense")) {
            errMsg =
              "Bot defense check failed. Please reload the page and try again.";
          } else if (errBody.error?.includes("consent")) {
            errMsg = "Health data consent is required. Please try again.";
          } else {
            errMsg = errBody.error || "Upload failed. Please try again.";
          }
          setError(errMsg);
          setUploading(false);
          setUploaded(false);
          setUploadStatus("error");
          throw new Error(errMsg);
        }

        const uploadResult = await res.json();
        setUploading(false);

        if (uploadResult.classification) {
          setClassification(uploadResult.classification);
        }

        // Set documentId LAST so the polling effect kicks off only after we've
        // also set uploadStatus to auto_processed (effect gates on both).
        if (uploadResult.autoProcessed) {
          // High confidence — backend triggered processing; poll for completion.
          setUploadStatus("auto_processed");
          if (uploadResult.documentId) {
            setDocumentId(uploadResult.documentId);
          }
          // Return promise that resolves when polling reaches a terminal state.
          // The polling effect populates promiseResolverRef.current on each
          // iteration's terminal-state branch.
          return new Promise<UploadResult>((resolve, reject) => {
            promiseResolverRef.current = { resolve, reject };
          });
        }

        if (uploadResult.status === "pending_review") {
          // Medium confidence — queued for admin review, no polling needed.
          setUploadStatus("pending_review");
          if (uploadResult.documentId) {
            setDocumentId(uploadResult.documentId);
          }
          return {
            documentId: uploadResult.documentId,
            status: "pending_review",
            classification: uploadResult.classification,
          };
        }

        if (uploadResult.status === "rejected") {
          // Low confidence — auto-declined.
          setUploadStatus("rejected");
          const errMsg =
            uploadResult.message ||
            "This document could not be identified as a healthcare document.";
          setError(errMsg);
          setUploading(false);
          if (uploadResult.documentId) {
            setDocumentId(uploadResult.documentId);
          }
          return {
            documentId: uploadResult.documentId,
            status: "rejected",
            classification: uploadResult.classification,
            rejected: { message: errMsg },
          };
        }

        // Fallthrough: EOB/bills that bypass classification — uploaded only.
        setUploadStatus("uploaded");
        if (uploadResult.documentId) {
          setDocumentId(uploadResult.documentId);
        }
        return {
          documentId: uploadResult.documentId,
          status: "uploaded",
          classification: uploadResult.classification,
        };
      } catch (err) {
        const errMsg =
          err instanceof Error
            ? err.message
            : "Upload failed. Please try again.";
        setError(errMsg);
        setUploading(false);
        setUploadStatus((s) => (s === "uploading" ? "error" : s));
        throw err;
      }
    },
    [user, defaultDocType, turnstileToken]
  );

  // ─── Consent helpers (caller renders modal JSX; hook owns state) ─────────

  const openConsentModal = useCallback((file: File) => {
    setPendingFile(file);
    setShowConsentModal(true);
  }, []);

  const closeConsentModal = useCallback(() => {
    setShowConsentModal(false);
    setPendingFile(null);
    setConsentChecked(false);
  }, []);

  const grantConsentAndUpload = useCallback(async () => {
    if (!pendingFile) return;
    await grantConsent();
    setShowConsentModal(false);
    setConsentChecked(false);
    const file = pendingFile;
    setPendingFile(null);
    await doUpload(file);
  }, [pendingFile, grantConsent, doUpload]);

  // ─── resumePolling — caller triggered a backend reprocess on existing doc ─
  const resumePolling = useCallback((docId: string) => {
    setDocumentId(docId);
    setUploadStatus("auto_processed");
    setProcessingProgress(null);
    setUploaded(true);
    setError("");
  }, []);

  // ─── reset ───────────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    setUploading(false);
    setUploaded(false);
    setUploadStatus("idle");
    setError("");
    setFileName("");
    setClassification(null);
    setDocumentId(null);
    setUploadProgress(0);
    setProcessingProgress(null);
    turnstileRef.current?.reset();
  }, []);

  return {
    // Upload state
    uploading,
    uploaded,
    uploadStatus,
    uploadProgress,
    documentId,
    processingProgress,
    classification,
    fileName,
    error,
    setError,
    // Turnstile
    turnstileToken,
    setTurnstileToken,
    turnstileRef,
    // Consent
    hasConsented,
    consentLoading,
    consentChecked,
    setConsentChecked,
    showConsentModal,
    pendingFile,
    openConsentModal,
    closeConsentModal,
    grantConsent,
    grantConsentAndUpload,
    // Actions
    doUpload,
    reset,
    resumePolling,
  };
}

// Re-export TurnstileWidget so callers can import the hook + widget together
export { TurnstileWidget };
export type { TurnstileWidgetHandle };
