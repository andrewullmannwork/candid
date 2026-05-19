"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useDropzone } from "react-dropzone";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { useConsent } from "@/lib/consent/use-consent";
import { getConsentDocument } from "@/lib/consent/consent-documents";
import { createBrowserClient } from "@/lib/supabase/client";
import { TurnstileWidget, type TurnstileWidgetHandle } from "@/components/security/TurnstileWidget";
import { ProcessingFlow } from "@/components/parsing/ProcessingFlow";
import { ShareCandidCard } from "@/components/share/ShareCandidCard";
import {
  DOC_TYPES,
  PICKER_OPTIONS,
  type DocType,
  type DocTypeConfirmation,
  type PickerOptionKey,
} from "@/lib/classifier/doc-type-vocabulary";

// ─── Upload form ────────────────────────────────────────────────────────────
//
// S100 Stage 7c Phase 2 rewrite: UploadForm slimmed to state + handlers + form
// view + dispatch to <ProcessingFlow> when uploaded. Removed:
//   - inline DocTypeConfirmation type (moved to doc-type-vocabulary)
//   - inline DOC_TYPES + PICKER_OPTIONS (moved to doc-type-vocabulary)
//   - inline PremiumPromptInline function (moved to components/parsing)
//   - inline DocTypeConfirmationModal JSX (now via ProcessingFlow priority 0)
//   - inline getExpectedDurationCopy (moved to lib/parsing/parseProgressUx)
//   - 4 B14 page-tick effects + playful-floor effect + messageTimer effect
//     (moved into UnifiedParseScreen + ProcessingFlow)
//   - getStepLabel / getStepSubtitle / READING_MESSAGES / EXTRACTING_MESSAGES /
//     INIT_MESSAGES / WHY_SUBTITLE (moved into UnifiedParseScreen + parseProgressUx)
//   - All inline mismatch / year_rollover / canonical_match prompt JSX (moved
//     into ParseTerminalView variants)
//   - All inline upload-progress + step-pills JSX (moved into UnifiedParseScreen)
//
// The S99 surgical Branch A gate (`uploadStatus !== "awaiting_confirmation"`)
// is now redundant — ProcessingFlow priority 0 catches awaiting_confirmation
// BEFORE any loader branch, structurally guaranteeing the doc-type-confirmation
// modal renders.

function UploadForm() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const needsSbc = searchParams.get("need_sbc") === "1";
  // S74.5c §3.1 — consume `?type=<plan|sbc|eob|itemized_bill>` so nudge
  // buttons (e.g., the Case C/D banner on /claim → "Upload plan") pre-select
  // the right doc type. `?type=plan` maps to plan_document; unknown values
  // fall through to the existing `need_sbc` / default branches.
  const typeParam = searchParams.get("type");
  const initialDocType: DocType =
    typeParam === "plan"
      ? "plan_document"
      : typeParam === "plan_document"
        ? "plan_document"
        : typeParam === "sbc"
          ? "sbc"
          : typeParam === "eob"
            ? "eob"
            : typeParam === "itemized_bill"
              ? "itemized_bill"
              : needsSbc
                ? "sbc"
                : "eob";

  const [docType, setDocType] = useState<DocType>(initialDocType);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<
    | "uploading"
    | "uploaded"
    | "auto_processed"
    | "pending_review"
    | "rejected"
    | "dedup_processed"
    | "awaiting_confirmation"
    | null
  >(null);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [showTips, setShowTips] = useState<PickerOptionKey | null>(null);
  const [profileMissing, setProfileMissing] = useState(false);
  const [classificationResult, setClassificationResult] = useState<{
    classifiedType: string;
    confidence: number;
    mismatch: boolean;
  } | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  // S78 — async ingestion gate: backend sets isLargeDoc=true for PDFs > 30 pages
  // when async_ingestion_ux_v1 feature flag is ON. Drives the large-doc splash
  // copy (personalized page count + duration tier + "Continue browsing" CTA)
  // vs the existing sync UnifiedParseScreen messaging.
  const [isLargeDoc, setIsLargeDoc] = useState(false);
  const [largeDocPageCount, setLargeDocPageCount] = useState<number | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [processingProgress, setProcessingProgress] = useState<{
    status: string;
    step: string | null;
    completedPages: number;
    totalPages: number;
    insurerMismatch?: {
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
    } | null;
    processingError?: string | null;
    retryCount?: number;
    isStuck?: boolean;
    linkedInsurancePlanId?: string | null;
    linkedPlanPremium?: number | null;
  } | null>(null);
  // Track whether the user has saved a premium for the just-uploaded plan
  // (suppresses re-prompting after save + lets the redirect proceed).
  const [premiumSaved, setPremiumSaved] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [yearRolloverEnabled, setYearRolloverEnabled] = useState(false);

  // Previously uploaded documents
  const [userDocs, setUserDocs] = useState<
    { id: string; file_name: string; doc_type: string; status: string; created_at: string; processing_error?: string | null; retry_count?: number }[]
  >([]);
  const [retryingDocId, setRetryingDocId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const supabase = createBrowserClient();
    supabase
      .from("documents")
      .select("id, file_name, doc_type, status, created_at, processing_error, retry_count")
      .eq("user_id", user.userId)
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (data) setUserDocs(data);
      });
    // Check feature flag for year rollover UI
    supabase
      .from("feature_flag_rules")
      .select("enabled")
      .eq("flag_key", "plan_year_rollover")
      .eq("target_type", "global")
      .single()
      .then(({ data }) => {
        if (data?.enabled) setYearRolloverEnabled(true);
      });
  }, [user, uploaded]);

  // Consent state — inline, not blocking
  const { hasConsented, grantConsent } = useConsent("health_data_upload");
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [consentSubmitting, setConsentSubmitting] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const consentDoc = getConsentDocument("health_data_upload");

  // Cloudflare Turnstile (S68) — bot defense on upload. Token is single-use,
  // so widgetRef.current.reset() is called after each upload attempt to issue
  // a fresh token for the next file.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileTokenRef = useRef<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);
  // S91 — XHR ref for the active upload so the X-out cancel button can abort
  // bytes-in-flight. Cleared when the upload settles (success, error, or abort).
  const uploadXhrRef = useRef<XMLHttpRequest | null>(null);
  const [userPickedFile, setUserPickedFile] = useState(false);

  // S94 B5 — doc-type confirmation modal. Server returns
  // awaitingDocTypeConfirmation:true when the regex classifier disagrees with
  // the user pick at moderate confidence (band configurable via mig 104).
  const [confirmationData, setConfirmationData] = useState<DocTypeConfirmation | null>(null);

  useEffect(() => {
    turnstileTokenRef.current = turnstileToken;
  }, [turnstileToken]);

  // Retry a failed or stuck document
  const retryDocument = useCallback(
    async (docId: string) => {
      if (!user || retrying) return;
      setRetrying(true);
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/documents/reprocess", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ documentId: docId }),
        });
        if (res.ok) {
          // Resume polling for the retried document
          setDocumentId(docId);
          setUploadStatus("auto_processed");
          setProcessingProgress(null);
          setUploaded(true);
          // Refresh doc list
          const supabase = createBrowserClient();
          const { data } = await supabase
            .from("documents")
            .select("id, file_name, doc_type, status, created_at, processing_error, retry_count")
            .eq("user_id", user.userId)
            .order("created_at", { ascending: false });
          if (data) setUserDocs(data);
        } else {
          const errBody = await res.json().catch(() => ({}));
          setError(errBody.error || "Retry failed. Please try again.");
        }
      } catch {
        setError("Retry failed. Please try again.");
      } finally {
        setRetrying(false);
      }
    },
    [user, retrying],
  );

  // Poll processing status and trigger chunks for large documents
  useEffect(() => {
    if (!documentId || uploadStatus !== "auto_processed") return;

    let active = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/documents/status?id=${documentId}`);
        if (!res.ok || !active) return;
        const data = await res.json();
        setProcessingProgress(data);

        if (data.status === "processed") {
          active = false;
          if (data.insurerMismatch?.mismatch || data.insurerMismatch?.pending_canonical_match) {
            // Mismatch or canonical match confirmation needed — show prompt
            setProcessingProgress(data);
          } else {
            // No mismatch — decide between auto-redirect or premium prompt.
            // Plan-type docs (SBC, plan_document) land on /dashboard per the
            // Session 72 user direction (dashboard exposes /plan for benefits).
            // Bill-type docs (eob, itemized_bill) auto-route to /claim per the
            // Session 81 (post-walkthrough) user direction — /claim is the
            // tabbed UX with bill cards, discrepancies, and disputes; /audit
            // is a bare line-items table that duplicates the bill detail view.
            const isPlanType = docType === "sbc" || docType === "plan_document";
            const isBillType = docType === "eob" || docType === "itemized_bill";
            // SBCs don't include premium — if it's missing, hold the redirect
            // and let the user fill it in via the inline premium prompt.
            const needsPremium = isPlanType && data.linkedPlanPremium == null;
            const redirectTarget = isBillType ? "/claim" : "/dashboard";
            console.log("[upload] processed branch:", {
              docType,
              isPlanType,
              isBillType,
              linkedPlanPremium: data.linkedPlanPremium,
              linkedInsurancePlanId: data.linkedInsurancePlanId,
              needsPremium,
              willAutoRedirect: !needsPremium,
              redirectTarget,
            });
            if (!needsPremium) {
              setTimeout(() => {
                window.location.href = redirectTarget;
              }, 1500);
            }
          }
          return;
        }

        if (data.status === "pending_review") {
          active = false;
          setUploadStatus("pending_review");
          return;
        }

        if (data.status === "error" || data.isStuck) {
          active = false;
          return;
        }

        // If needs triggering, call the trigger endpoint
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

    // Start immediately, then poll every 4 seconds
    poll();
    const interval = setInterval(poll, 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [documentId, uploadStatus]);

  // Check if insurance profile is filled
  useEffect(() => {
    if (!user) return;
    async function checkProfile() {
      try {
        const idToken = await user!.firebaseUser.getIdToken();
        const res = await fetch("/api/profile", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (res.ok) {
          const { profile } = await res.json();
          if (!profile || !profile.insurer) {
            setProfileMissing(true);
          }
        }
      } catch {
        // Non-critical — don't block upload
      }
    }
    checkProfile();
  }, [user]);

  // Actual upload logic — called after consent is confirmed
  const doUpload = useCallback(
    async (file: File) => {
      if (!user) return;
      setUploading(true);
      setError("");
      setFileName(file.name);
      // CF-34 (Session 72) FIX v2: do NOT set uploaded=true yet. The form view
      // hosts the TurnstileWidget render (it lives inside the form return; the
      // `if (uploaded)` early-return jumps to the progress view which doesn't
      // render the widget). If we flip uploaded=true now, React unmounts the
      // form → widget never mounts → no token issued → server returns 403
      // "missing-input-response". Wait for the token BEFORE the flip so the
      // widget has a chance to issue.

      try {
        // Poll up to 12s for Turnstile token.
        const tokenWaitStart = Date.now();
        while (!turnstileTokenRef.current && Date.now() - tokenWaitStart < 12000) {
          await new Promise((r) => setTimeout(r, 200));
        }
        const tokenForUpload = turnstileTokenRef.current;

        // Now safe to flip to progress view — token (if any) is captured.
        setUploaded(true);
        setUploadStatus("uploading");

        const idToken = await user.firebaseUser.getIdToken();

        // Upload file via API to bypass RLS
        const formData = new FormData();
        formData.append("file", file);
        formData.append("docType", docType);
        if (tokenForUpload) formData.append("turnstileToken", tokenForUpload);

        // Use XHR for upload progress tracking
        setUploadProgress(0);
        const res = await new Promise<Response>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          uploadXhrRef.current = xhr;
          xhr.upload.addEventListener("progress", (e) => {
            if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
          });
          xhr.addEventListener("load", () => {
            uploadXhrRef.current = null;
            resolve(new Response(xhr.responseText, { status: xhr.status, headers: { "content-type": "application/json" } }));
          });
          xhr.addEventListener("error", () => {
            uploadXhrRef.current = null;
            reject(new Error("Upload failed"));
          });
          xhr.addEventListener("abort", () => {
            uploadXhrRef.current = null;
            reject(new Error("Upload aborted by user"));
          });
          xhr.open("POST", "/api/documents/upload");
          xhr.setRequestHeader("Authorization", `Bearer ${idToken}`);
          xhr.send(formData);
        });

        // Reset Turnstile so the next upload gets a fresh token (single-use).
        turnstileRef.current?.reset();

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          if (res.status === 403 && errBody.error?.includes("Bot defense")) {
            setError("Bot defense check failed. Please reload the page and try again.");
          } else if (errBody.error?.includes("consent")) {
            setError("Health data consent is required. Please try again.");
          } else {
            setError(errBody.error || "Upload failed. Please try again.");
          }
          setUploading(false);
          setUploaded(false);
          setUploadStatus(null);
          return;
        }

        const uploadResult = await res.json();

        // Save document ID for processing status polling
        if (uploadResult.documentId) {
          setDocumentId(uploadResult.documentId);
        }

        // S93 Bug A fix — handle dedup-of-processed cleanly. When upload route
        // returns deduplicated:true (file_hash matched a prior PROMOTED canonical
        // upload by this user — see S93 Bug C tightening in /api/documents/upload),
        // the existing doc is already processed; there's no parsing work to wait
        // on. Pre-fix behavior fell through to status="uploaded" + polling, which
        // got stuck on the PlayfulParsingScreen "Queued" pill (Bug B was the
        // visible symptom; this is the upstream cause). Post-fix: route the user
        // immediately to their results based on doc type.
        if (uploadResult.deduplicated === true && uploadResult.status === "processed") {
          console.log(
            `[upload] dedup-of-processed hit (reason=${uploadResult.deduplicationReason ?? "unspecified"}); routing to results`,
          );
          const isPlanDoc = docType === "sbc" || docType === "plan_document";
          const isBill = docType === "eob" || docType === "itemized_bill";
          const target = isPlanDoc ? "/plan" : isBill ? "/audit" : "/dashboard";
          setUploadStatus("dedup_processed");
          setUploaded(true);
          setUploading(false);
          setTimeout(() => {
            window.location.href = target;
          }, 600);
          return;
        }

        // Backend now handles confidence-gated processing automatically
        if (uploadResult.classification) {
          setClassificationResult(uploadResult.classification);
          // S91 — page count drives duration-copy tier in
          // getExpectedDurationCopy() regardless of async-UX flag state.
          if (typeof uploadResult.classification.pageCount === "number") {
            setLargeDocPageCount(uploadResult.classification.pageCount);
          }
        }

        // S78 — capture large-doc flag for async UX splash + email-on-complete.
        // Backend sets to true only when async_ingestion_ux_v1 flag is ON, PDF,
        // and pageCount > 30.
        if (uploadResult.isLargeDoc) {
          setIsLargeDoc(true);
        }

        // Handle different processing outcomes
        if (uploadResult.awaitingDocTypeConfirmation === true && uploadResult.confirmation) {
          // S94 B5 — server halted at awaiting_doc_type_confirmation because the
          // regex classifier disagreed with the user's pick at moderate confidence.
          // Show modal via ProcessingFlow priority 0 dispatch.
          setConfirmationData(uploadResult.confirmation as DocTypeConfirmation);
          setUploadStatus("awaiting_confirmation");
          setUploaded(true);
          setUploading(false);
          return;
        }
        if (uploadResult.autoProcessed) {
          // High confidence — processing triggered automatically.
          // S100 v3 fix: seed processingProgress with the classifier's page
          // count so UnifiedParseScreen shows "Page 0 of N" immediately
          // (no gap waiting for the first /api/documents/status poll).
          setUploadStatus("auto_processed");
          if (uploadResult.classification?.pageCount && uploadResult.classification.pageCount > 0) {
            setProcessingProgress({
              status: "queued",
              step: null,
              completedPages: 0,
              totalPages: uploadResult.classification.pageCount,
            });
          }
        } else if (uploadResult.status === "pending_review") {
          // Medium confidence — queued for admin review
          setUploadStatus("pending_review");
        } else if (uploadResult.status === "rejected") {
          // Low confidence — auto-declined
          setUploadStatus("rejected");
          setError(uploadResult.message || "This document could not be identified as a healthcare document.");
          setUploading(false);
          return;
        } else {
          // For EOB/bills that bypass classification, store for manual audit
          sessionStorage.setItem(
            "pendingAudit",
            JSON.stringify({ documentId: uploadResult.documentId, billType: docType, fileName: file.name }),
          );
          setUploadStatus("uploaded");
        }

        setUploaded(true);
      } catch (err) {
        console.error("Upload error:", err);
        setError("Upload failed. Please try again.");
      } finally {
        setUploading(false);
      }
    },
    [user, docType],
  );

  // Intercept drop: validate file, then check consent before uploading.
  // CF-34 (Session 72): also flips userPickedFile so the Turnstile widget
  // mounts at this exact moment — the widget will load + capture a token
  // while the user works through the consent modal (or immediately if already
  // consented), keeping captcha out of the way until it's actually needed.
  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (!user || acceptedFiles.length === 0) return;

      const file = acceptedFiles[0];
      const allowedTypes = ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif"];
      const isHeic = /\.(heic|heif)$/i.test(file.name);
      if (!allowedTypes.includes(file.type) && !isHeic) {
        setError("Accepted formats: PDF, JPEG, PNG, or HEIC (iPhone photos).");
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        setError("File must be under 20MB.");
        return;
      }

      // Mount Turnstile (CF-34): even though it takes ~3-5s to issue a token,
      // the consent modal flow gives it that time naturally. doUpload polls
      // the ref so the upload waits if the token isn't ready yet.
      setUserPickedFile(true);

      // If consent already granted, upload immediately
      if (hasConsented) {
        doUpload(file);
      } else {
        // Stash the file and show consent modal
        setPendingFile(file);
        setShowConsentModal(true);
      }
    },
    [user, hasConsented, doUpload],
  );

  // After consent is granted, upload the pending file
  async function handleConsentGrant() {
    setConsentSubmitting(true);
    try {
      await grantConsent();
      setShowConsentModal(false);
      setConsentChecked(false);
      if (pendingFile) {
        doUpload(pendingFile);
        setPendingFile(null);
      }
    } catch (err) {
      console.error("Consent grant failed:", err);
      setError("Failed to record consent. Please try again.");
    } finally {
      setConsentSubmitting(false);
    }
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "application/pdf": [".pdf"],
      "image/jpeg": [".jpg", ".jpeg"],
      "image/png": [".png"],
      "image/heic": [".heic"],
      "image/heif": [".heif"],
    },
    maxFiles: 1,
    disabled: uploading,
  });

  // ─── ProcessingFlow callbacks ────────────────────────────────────────────
  //
  // Lifted from inline onClick handlers in the legacy if-uploaded block. Each
  // callback owns its API call + state mutation; ProcessingFlow + nested
  // ParseTerminalView / DocTypeConfirmationModal trigger them as user actions.

  const onCancelInFlight = useCallback(() => {
    // S91 — cancel handler for the X-out button in UnifiedParseScreen.
    //   - During isUploading: abort the in-flight XHR (truly cancels bytes).
    //   - During processing: POST `action: "cancel"` to /api/documents/status
    //     which sets status='error' + processing_step='canceled_by_user'.
    //   - Always: clear local UI state so the user can move on.
    if (uploadXhrRef.current) {
      try {
        uploadXhrRef.current.abort();
      } catch {
        /* ignore — XHR already settled */
      }
      uploadXhrRef.current = null;
    }
    if (documentId && user) {
      (async () => {
        try {
          const token = await user.firebaseUser.getIdToken();
          await fetch("/api/documents/status", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ documentId, action: "cancel" }),
          });
        } catch {
          /* fire-and-forget */
        }
      })();
    }
    setUploaded(false);
    setUploadStatus(null);
    setFileName("");
    setProcessingProgress(null);
    setDocumentId(null);
    setUploadProgress(0);
    setError("");
  }, [documentId, user]);

  const onUploadAnother = useCallback(() => {
    setUploaded(false);
    setUploadStatus(null);
    setFileName("");
    setClassificationResult(null);
    setProcessingProgress(null);
    setDocumentId(null);
    setUploadProgress(0);
    setUserPickedFile(false);
    setPremiumSaved(false);
  }, []);

  const onConfirmDocType = useCallback(
    async (confirmedDocType: DocType) => {
      if (!user || !documentId) return;
      // Optimistic transition — flip state immediately so the modal unmounts
      // + ProcessingFlow drops to priority 10 (UnifiedParseScreen) on the next
      // render. The API call runs in parallel; the polling effect will pick up
      // the queued-then-processing-then-processed state changes from the
      // backend as the chunk runs. Per Andrew S100 direction: "when I click the
      // document type it should go to the loading page, not stay on the choice
      // modal."
      //
      // S100 v3 fix: seed processingProgress with the page count we already
      // know from the classifier (carried on confirmationData.page_count) so
      // UnifiedParseScreen can render "Page 0 of N" immediately instead of
      // briefly rendering with no status text while the first poll roundtrips.
      const pageCountHint = confirmationData?.page_count ?? null;
      setDocType(confirmedDocType);
      setConfirmationData(null);
      setUploadStatus("auto_processed");
      setProcessingProgress(
        pageCountHint && pageCountHint > 0
          ? {
              status: "queued",
              step: null,
              completedPages: 0,
              totalPages: pageCountHint,
            }
          : null,
      );
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/documents/confirm-doc-type", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ documentId, action: "confirm", confirmedDocType }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || "Confirmation failed");
        }
        // Success — backend re-enqueued chunk; polling effect drives the rest.
      } catch (err) {
        // Revert optimistic transition + surface error on the form view.
        console.error("[upload] doc-type confirmation failed:", err);
        setError(err instanceof Error ? err.message : "Couldn't confirm document type. Please upload again.");
        setUploaded(false);
        setUploadStatus(null);
        setProcessingProgress(null);
        setDocumentId(null);
      }
    },
    [user, documentId],
  );

  const onCancelConfirmation = useCallback(async () => {
    if (user && documentId) {
      try {
        const idToken = await user.firebaseUser.getIdToken();
        await fetch("/api/documents/confirm-doc-type", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ documentId, action: "cancel" }),
        });
      } catch {
        // Non-fatal — even if the cancel POST fails, reset the UI.
      }
    }
    setConfirmationData(null);
    setUploadStatus(null);
    setUploaded(false);
    setDocumentId(null);
    setFileName("");
  }, [user, documentId]);

  const onUseThisPlanFromMismatch = useCallback(async () => {
    if (!user || !processingProgress?.insurerMismatch) return;
    const mm = processingProgress.insurerMismatch;
    try {
      const idToken = await user.firebaseUser.getIdToken();
      // S91 Option B — record disambiguation choice for feedback loop
      void fetch("/api/documents/status", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          documentId,
          action: "record_disambiguation",
          choice: "use_this_plan",
          modalType: "insurer_mismatch",
        }),
      }).catch(() => {
        /* fire-and-forget */
      });

      const profileUpdate: Record<string, string> = {};
      const isPlanMismatch = mm.type === "plan_name";
      if (isPlanMismatch) {
        profileUpdate.plan_name = mm.parsedPlanName || "";
      } else {
        profileUpdate.insurer = mm.parsedInsurer || "";
      }
      const profileRes = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(profileUpdate),
      });
      if (!profileRes.ok) console.error("Profile update failed:", await profileRes.text());

      const activateRes = await fetch("/api/documents/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, action: "activate_plan" }),
      });
      if (!activateRes.ok) {
        console.error("Plan activation failed:", await activateRes.text());
      } else {
        const activateData = await activateRes.json();
        if (activateData.needsCardRescan) {
          window.location.href = "/profile?rescan_card=1";
          return;
        }
      }

      window.location.href = "/plan";
    } catch (err) {
      console.error("Activation error:", err);
      setError("Failed to activate plan. Please try again.");
    }
  }, [user, processingProgress, documentId]);

  const onKeepCurrentFromMismatch = useCallback(async () => {
    // S91 Option B — fire-and-forget disambiguation log before clearing local state
    if (user && documentId) {
      const token = await user.firebaseUser.getIdToken().catch(() => null);
      if (token) {
        void fetch("/api/documents/status", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            documentId,
            action: "record_disambiguation",
            choice: "keep_current",
            modalType: "insurer_mismatch",
          }),
        }).catch(() => {
          /* fire-and-forget */
        });
      }
    }
    setUploaded(false);
    setUploadStatus(null);
    setFileName("");
    setProcessingProgress(null);
    setDocumentId(null);
  }, [user, documentId]);

  const onSwitchYearRollover = useCallback(async () => {
    if (!user) return;
    try {
      const idToken = await user.firebaseUser.getIdToken();
      void fetch("/api/documents/status", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          documentId,
          action: "record_disambiguation",
          choice: "use_this_plan",
          modalType: "year_rollover",
        }),
      }).catch(() => {
        /* fire-and-forget */
      });
      const activateRes = await fetch("/api/documents/status", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ documentId, action: "activate_plan" }),
      });
      if (!activateRes.ok) {
        console.error("Year rollover activation failed:", await activateRes.text());
      }
      window.location.href = "/plan";
    } catch (err) {
      console.error("Year rollover error:", err);
      setError("Failed to switch plan year. Please try again.");
    }
  }, [user, documentId]);

  const onKeepCurrentYearRollover = useCallback(async () => {
    if (user && documentId) {
      const token = await user.firebaseUser.getIdToken().catch(() => null);
      if (token) {
        void fetch("/api/documents/status", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            documentId,
            action: "record_disambiguation",
            choice: "keep_current",
            modalType: "year_rollover",
          }),
        }).catch(() => {
          /* fire-and-forget */
        });
      }
    }
    setUploaded(false);
    setUploadStatus(null);
    setFileName("");
    setProcessingProgress(null);
    setDocumentId(null);
  }, [user, documentId]);

  const onConfirmCanonicalMatch = useCallback(async () => {
    try {
      const res = await fetch("/api/documents/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, action: "confirm_canonical_match" }),
      });
      if (!res.ok) console.error("Canonical confirm failed:", await res.text());
      window.location.href = "/plan";
    } catch (err) {
      console.error("Canonical confirm error:", err);
      setError("Failed to confirm plan match. Please try again.");
    }
  }, [documentId]);

  const onRejectCanonicalMatch = useCallback(async () => {
    try {
      const res = await fetch("/api/documents/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, action: "reject_canonical_match" }),
      });
      if (!res.ok) console.error("Canonical reject failed:", await res.text());
      window.location.href = "/plan";
    } catch (err) {
      console.error("Canonical reject error:", err);
      setError("Failed to process. Please try again.");
    }
  }, [documentId]);

  const onRetryDocument = useCallback(async () => {
    if (!documentId) return;
    await retryDocument(documentId);
  }, [documentId, retryDocument]);

  const onPremiumSaved = useCallback(() => {
    setPremiumSaved(true);
    // Session 72 user direction: post-action redirects also go to /dashboard
    // (consistency with the no-prompt auto-redirect).
    setTimeout(() => {
      window.location.href = "/dashboard";
    }, 800);
  }, []);

  const onPremiumSkipped = useCallback(() => {
    setPremiumSaved(true);
    window.location.href = "/dashboard";
  }, []);

  // ─── Progress / Success state ──────────────────────────────────────────
  //
  // S100 Stage 7c: all post-upload UX (uploading / parsing / modal / mismatch /
  // year_rollover / canonical_match / complete / error / etc.) dispatched via
  // <ProcessingFlow>. The doc-type-confirmation modal renders via priority 0
  // BEFORE any loader branch — closes the S99 frontend-modal-not-rendering bug
  // at the structural level.

  if (uploaded) {
    return (
      <ProcessingFlow
        documentId={documentId}
        fileName={fileName}
        docType={docType}
        user={user}
        uploaded={uploaded}
        uploadStatus={uploadStatus}
        uploadProgress={uploadProgress}
        confirmationData={confirmationData}
        processingProgress={processingProgress}
        classificationResult={classificationResult}
        isLargeDoc={isLargeDoc}
        largeDocPageCount={largeDocPageCount}
        yearRolloverEnabled={yearRolloverEnabled}
        premiumSaved={premiumSaved}
        retrying={retrying}
        onCancelInFlight={onCancelInFlight}
        onUploadAnother={onUploadAnother}
        onConfirmDocType={onConfirmDocType}
        onCancelConfirmation={onCancelConfirmation}
        onUseThisPlanFromMismatch={onUseThisPlanFromMismatch}
        onKeepCurrentFromMismatch={onKeepCurrentFromMismatch}
        onSwitchYearRollover={onSwitchYearRollover}
        onKeepCurrentYearRollover={onKeepCurrentYearRollover}
        onConfirmCanonicalMatch={onConfirmCanonicalMatch}
        onRejectCanonicalMatch={onRejectCanonicalMatch}
        onRetryDocument={onRetryDocument}
        onPremiumSaved={onPremiumSaved}
        onPremiumSkipped={onPremiumSkipped}
      />
    );
  }

  // ── Upload form ─────────────────────────────────────────────────────────
  return (
    <div className="max-w-lg mx-auto">
      <h1 className="text-2xl font-bold text-gray-900">Upload a document</h1>
      <p className="mt-1.5 text-sm text-gray-500">
        Upload your EOB or itemized bill. We&apos;ll extract every line item and run it through our audit engine.
      </p>

      {/* SBC upload prompt after plan switch */}
      {needsSbc && (
        <div className="mt-5 p-4 bg-blue-50 border border-blue-100 rounded-2xl flex items-start gap-3">
          <svg className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <div>
            <p className="text-sm font-semibold text-blue-800">Upload your plan document</p>
            <p className="text-xs text-blue-600 mt-0.5">
              You switched insurance plans. Upload your new Summary of Benefits and Coverage (SBC) so we can populate your benefits.
            </p>
          </div>
        </div>
      )}

      {/* Profile missing banner */}
      {profileMissing && (
        <div className="mt-5 p-4 bg-blue-50 border border-blue-100 rounded-2xl flex items-start gap-3">
          <svg className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p className="text-sm font-medium text-blue-800">Add your insurance info first</p>
            <p className="text-xs text-blue-600 mt-0.5">Your audit will be more accurate if we know your plan details.</p>
            <Link href="/profile" className="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-blue-700 hover:text-blue-900">
              Complete your profile
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>
      )}

      <div className="mt-6 space-y-5">
        {/* Document type selector — S92 Stage 1: 2-card picker. Wire type
            (`docType`) stays as the 4-tuple; picker is just a 2-card visual
            collapse that maps to default wire types via `selectsAs`. */}
        <div>
          <label className="text-sm font-medium text-gray-700 mb-2 block">What are you uploading?</label>
          <div className="grid grid-cols-2 gap-3">
            {(Object.keys(PICKER_OPTIONS) as PickerOptionKey[]).map((pickerKey) => {
              const option = PICKER_OPTIONS[pickerKey];
              const billFamily: ReadonlyArray<typeof docType> = ["eob", "itemized_bill"];
              const planFamily: ReadonlyArray<typeof docType> = ["sbc", "plan_document"];
              const family = pickerKey === "bill" ? billFamily : planFamily;
              const selected = family.includes(docType);
              const selectAndShowTips = () => {
                setDocType(option.selectsAs);
                setShowTips(pickerKey);
              };
              return (
                <div
                  key={pickerKey}
                  role="button"
                  tabIndex={0}
                  onClick={selectAndShowTips}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") selectAndShowTips();
                  }}
                  className={`relative p-4 rounded-2xl border-2 text-left transition-all cursor-pointer ${
                    selected ? "border-blue-500 bg-blue-50/50" : "border-gray-200 hover:border-gray-300 bg-white"
                  }`}
                >
                  <p className={`text-sm font-semibold ${selected ? "text-blue-700" : "text-gray-900"}`}>{option.short}</p>
                  <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{option.description}</p>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowTips(showTips === pickerKey ? null : pickerKey);
                    }}
                    className="mt-2 text-[11px] font-medium text-blue-600 hover:text-blue-700"
                  >
                    {showTips === pickerKey ? "Hide tips" : "Where do I find this?"}
                  </button>
                  {selected && (
                    <div className="absolute top-2.5 right-2.5 w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center">
                      <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Tips panel */}
          {showTips && (
            <div className="mt-3 p-4 bg-gray-50 rounded-2xl space-y-2">
              <p className="text-xs font-semibold text-gray-600 uppercase tracking-widest">
                How to find your {PICKER_OPTIONS[showTips].short}
              </p>
              <ul className="space-y-1.5">
                {PICKER_OPTIONS[showTips].tips.map((tip, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-gray-500">
                    <span className="w-4 h-4 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                      {i + 1}
                    </span>
                    {tip}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Drop zone */}
        <div
          {...getRootProps()}
          className={`relative flex flex-col items-center justify-center gap-3 p-8 border-2 border-dashed rounded-2xl cursor-pointer transition-all ${
            isDragActive ? "border-blue-400 bg-blue-50" : "border-gray-200 bg-gray-50 hover:border-blue-300 hover:bg-blue-50/50"
          } ${uploading ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <input {...getInputProps()} />
          {uploading ? (
            <div className="w-full max-w-[240px] text-center">
              <p className="text-sm text-gray-600 font-medium mb-2">Uploading{uploadProgress < 100 ? "..." : " complete"}</p>
              <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full bg-blue-600 rounded-full transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
              </div>
              <p className="text-xs text-gray-400 mt-1.5">
                {fileName} — {uploadProgress}%
              </p>
            </div>
          ) : isDragActive ? (
            <>
              <div className="w-12 h-12 rounded-2xl bg-blue-100 flex items-center justify-center">
                <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
              </div>
              <p className="text-sm font-medium text-blue-600">Drop your PDF here</p>
            </>
          ) : (
            <>
              <div className="w-12 h-12 rounded-2xl bg-blue-100 flex items-center justify-center">
                <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-700">
                  Drop your file here, or <span className="text-blue-600">browse</span>
                </p>
                <p className="text-xs text-gray-400 mt-1">PDF only · Max 20MB</p>
              </div>
            </>
          )}
        </div>

        {/* Cloudflare Turnstile — bot defense (S68). CF-34 (Session 72): widget
            mounts after the user picks a file AND uses appearance="execute" so
            it stays invisible when Cloudflare silently issues a token. */}
        {userPickedFile && (
          <TurnstileWidget ref={turnstileRef} action="upload" onToken={setTurnstileToken} appearance="execute" />
        )}

        {error && (
          <div className="p-3 bg-red-50 border border-red-100 rounded-xl">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}
      </div>

      {/* ── Previously uploaded documents ──────────────────────────────────── */}
      {userDocs.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Your uploaded documents</h2>
          <div className="space-y-2">
            {userDocs.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between p-3 bg-white border border-gray-100 rounded-xl">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center shrink-0">
                    <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{doc.file_name}</p>
                    <p className="text-xs text-gray-400">
                      {DOC_TYPES[doc.doc_type as keyof typeof DOC_TYPES]?.short || doc.doc_type}
                      {" · "}
                      {new Date(doc.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {doc.status === "error" && (doc.retry_count || 0) < 3 && (
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        setRetryingDocId(doc.id);
                        await retryDocument(doc.id);
                        setRetryingDocId(null);
                      }}
                      disabled={retryingDocId === doc.id}
                      className="text-xs font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-50"
                    >
                      {retryingDocId === doc.id ? "..." : "Retry"}
                    </button>
                  )}
                  <span
                    className={`text-xs font-medium px-2 py-1 rounded-full ${
                      doc.status === "processed"
                        ? "bg-green-50 text-green-700"
                        : doc.status === "processing" || doc.status === "queued"
                          ? "bg-blue-50 text-blue-700"
                          : doc.status === "pending_review"
                            ? "bg-amber-50 text-amber-700"
                            : doc.status === "error"
                              ? "bg-red-50 text-red-700"
                              : "bg-gray-50 text-gray-500"
                    }`}
                  >
                    {doc.status === "processed"
                      ? "Processed"
                      : doc.status === "processing"
                        ? "Processing"
                        : doc.status === "queued"
                          ? "Queued"
                          : doc.status === "pending_review"
                            ? "Under review"
                            : doc.status === "error"
                              ? "Error"
                              : "Uploaded"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* "Help us grow" share card — placed on the form view (before upload)
          per user feedback so it's visible while users are deciding whether
          to upload, not only after they've completed one. */}
      <ShareCandidCard surface="upload_form" />

      {/* ── Inline consent modal — shown on first upload attempt ─────────── */}
      {showConsentModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[80vh] flex flex-col shadow-2xl">
            <div className="p-6 border-b">
              <h2 className="text-xl font-bold text-gray-900">{consentDoc.title}</h2>
              <p className="text-sm text-gray-500 mt-1">Version {consentDoc.version} — Required before uploading health documents</p>
            </div>

            <div className="p-6 overflow-y-auto flex-1">
              <pre className="whitespace-pre-wrap font-sans text-sm text-gray-700 leading-relaxed">{consentDoc.fullText}</pre>
            </div>

            <div className="p-6 border-t space-y-4">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={consentChecked}
                  onChange={(e) => setConsentChecked(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-gray-300"
                />
                <span className="text-sm text-gray-700">
                  I have read and understand the above {consentDoc.title} and I explicitly consent to its terms.
                </span>
              </label>

              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => {
                    setShowConsentModal(false);
                    setConsentChecked(false);
                    setPendingFile(null);
                  }}
                  className="px-4 py-2 text-gray-600 hover:text-gray-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  disabled={!consentChecked || consentSubmitting}
                  onClick={handleConsentGrant}
                  className="px-6 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-semibold text-sm"
                >
                  {consentSubmitting ? "Processing..." : "I Accept — Upload"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function UploadPage() {
  return <UploadForm />;
}
