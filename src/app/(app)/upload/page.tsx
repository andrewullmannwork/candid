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
import { useProcessingFlowSlots } from "@/components/parsing/ProcessingFlow";
import { ShareWithFriend } from "@/components/share/share-with-friend";
import { TypeCard } from "@/components/upload/TypeCard";
import { PathCard } from "@/components/upload/PathCard";
import { DropIdle, DropHover, DropUploading } from "@/components/upload/DropZoneStates";
import { FindTipsPanel } from "@/components/upload/FindTipsPanel";
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
  // B2-UP.1 (#4 UX fix) — captures backend Pattern P silent override so the
  // frontend can render a correction banner + reconcile docType for
  // downstream wiring (DropDone CTA label + redirect target). Null when no
  // override happened (user's pick matched classifier OR confidence too low
  // to override).
  const [resolvedDocType, setResolvedDocType] = useState<DocType | null>(null);
  // Original user pick captured at upload time so the banner can name the
  // user's intent vs the corrected type. Cleared on reset.
  const [userPickAtUpload, setUserPickAtUpload] = useState<DocType | null>(null);
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
    smartSkipOutcome?: string | null;
  } | null>(null);
  // Track whether the user has saved a premium for the just-uploaded plan
  // (suppresses re-prompting after save + lets the redirect proceed).
  const [premiumSaved, setPremiumSaved] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [yearRolloverEnabled, setYearRolloverEnabled] = useState(false);
  // B2-UP.1 (D-§1.B.1-C) — Care path teaser feature-flag gate. When ON, the
  // 4th PathCard routes to /care; when OFF, render disabled "Coming soon"
  // chrome ("Notify me" lead-gen capture deferred to fast-follow). Flag
  // default OFF until Phase 2 staged rollout.
  const [candidCareLive, setCandidCareLive] = useState(false);

  // S101 v3 — auto-redirect gating. The polling effect detects status===
  // processed and (when no mismatch / no premium-needed) stages a redirect
  // target in this ref instead of firing window.location.href immediately.
  // ProcessingFlow's onProgressionComplete callback flips progressionComplete
  // → an effect below fires the actual navigation. Result: the sub-phase
  // machine plays out in full before we leave /upload.
  const pendingRedirectRef = useRef<string | null>(null);
  const [progressionComplete, setProgressionComplete] = useState(false);

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
    // B2-UP.1 (D-§1.B.1-C) — Care path teaser feature flag.
    supabase
      .from("feature_flag_rules")
      .select("enabled")
      .eq("flag_key", "candid_care_live")
      .eq("target_type", "global")
      .single()
      .then(({ data }) => {
        if (data?.enabled) setCandidCareLive(true);
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
        // S101 two-flow fix: preserve the seeded totalPages when the backend's
        // first poll responses surface 0/null. The seed comes from either
        // uploadResult.classification.pageCount (auto-accept path; line 476)
        // or confirmationData.page_count (modal-confirm path; line 656). Both
        // are written into processingProgress BEFORE this poll runs; without
        // the merge guard the backend's first "queued" response (which arrives
        // before chunk-runner writes documents.processing_total_pages) would
        // clobber the seed with 0 and the UnifiedParseScreen would fall back
        // to the "Uploading" pill + "Reading…" status until the chunk runner
        // eventually surfaced totalPages. That's the S101 task #14 stuck-state
        // bug; this guard closes it at the data layer.
        setProcessingProgress((prev) => {
          const backendTotalPages = typeof data.totalPages === "number" ? data.totalPages : 0;
          if (backendTotalPages === 0 && prev?.totalPages && prev.totalPages > 0) {
            return { ...data, totalPages: prev.totalPages };
          }
          return data;
        });

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
              // S101 v3 — stage the redirect instead of firing setTimeout
              // immediately. The progression-complete effect below picks it
              // up once UnifiedParseScreen's sub-phase machine has played
              // out. Without this gate the page navigates 1.5s after status
              // flips processed, racing the sub-phase progression.
              pendingRedirectRef.current = redirectTarget;
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

  // S101 v3 — fire the staged redirect once the sub-phase machine signals
  // complete via ProcessingFlow's onProgressionComplete callback. The 800ms
  // pause gives the user a beat to register the "Ready" terminal state
  // before navigation.
  useEffect(() => {
    if (!progressionComplete) return;
    const target = pendingRedirectRef.current;
    if (!target) return;
    pendingRedirectRef.current = null;
    const t = setTimeout(() => {
      window.location.href = target;
    }, 800);
    return () => clearTimeout(t);
  }, [progressionComplete]);

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

        // B2-UP.1 (#4 UX fix) — reconcile docType with backend Pattern P
        // silent override at high confidence (≥0.95). When the resolved type
        // differs from user pick, snapshot the user pick (for banner copy),
        // set resolvedDocType (drives banner render), and update docType so
        // DropDone CTA + redirect target follow the corrected type.
        if (
          typeof uploadResult.resolvedDocType === "string" &&
          uploadResult.resolvedDocType !== docType
        ) {
          setUserPickAtUpload(docType);
          setResolvedDocType(uploadResult.resolvedDocType as DocType);
          setDocType(uploadResult.resolvedDocType as DocType);
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
        // S101 — silence the user-initiated abort path. onCancelInFlight has
        // already wiped local state; surfacing "Upload failed" here would
        // contradict the user's intent (they clicked X). XHR's abort event
        // rejects with this exact error message; everything else stays loud.
        if (err instanceof Error && err.message === "Upload aborted by user") {
          return;
        }
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
    disabled: uploading || uploaded,
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
    setProgressionComplete(false);
    // B2-UP.1 (#4) — clear correction banner state for the next upload.
    setResolvedDocType(null);
    setUserPickAtUpload(null);
    pendingRedirectRef.current = null;
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

      // S102 follow-up — Andrew direction: after "Use this plan" resolves a
      // mismatch, ALSO show the premium prompt before redirecting (parallel to
      // the clean-complete flow where it already shows). Only when premium is
      // actually missing — otherwise redirect straight to /plan as before.
      // Local mismatch clear: ProcessingFlow renders complete_plan variant once
      // insurerMismatch is null, which is the same variant that hosts
      // PremiumPromptInline. After save/skip, onPremiumSaved/Skipped redirects
      // to /dashboard (the standard post-premium destination, S72 direction).
      const premiumMissing = processingProgress.linkedPlanPremium == null;
      if (premiumMissing) {
        setProcessingProgress((prev) => (prev ? { ...prev, insurerMismatch: null } : prev));
        return;
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
  // <useProcessingFlowSlots>. The doc-type-confirmation modal renders via
  // priority 0 BEFORE any loader branch — closes the S99 frontend-modal-
  // not-rendering bug at the structural level.
  //
  // B2-UP.1 — slot-routing replaces the prior `if (uploaded) return
  // <ProcessingFlow />` full-screen takeover. The new design keeps the outer
  // shell (header + type cards + drop zone container + paths grid + share)
  // rendered always; slots route content into the right visual position.

  const isBillType = docType === "eob" || docType === "itemized_bill";
  const handleViewResults = useCallback(() => {
    const target = isBillType ? "/claim" : "/plan";
    window.location.href = target;
  }, [isBillType]);

  const slots = useProcessingFlowSlots({
    documentId,
    fileName,
    docType,
    user,
    uploaded,
    uploadStatus,
    uploadProgress,
    confirmationData,
    processingProgress,
    classificationResult,
    isLargeDoc,
    largeDocPageCount,
    yearRolloverEnabled,
    premiumSaved,
    retrying,
    onCancelInFlight,
    onUploadAnother,
    onConfirmDocType,
    onCancelConfirmation,
    onUseThisPlanFromMismatch,
    onKeepCurrentFromMismatch,
    onSwitchYearRollover,
    onKeepCurrentYearRollover,
    onConfirmCanonicalMatch,
    onRejectCanonicalMatch,
    onRetryDocument,
    onPremiumSaved,
    onPremiumSkipped,
    onProgressionComplete: () => setProgressionComplete(true),
    loaderVariant: "stackV3",
    onViewResults: handleViewResults,
  });

  // Picker-key derivation: which TypeCard is active for the current docType?
  const activePickerKey: PickerOptionKey = isBillType ? "bill" : "plan_document";

  // Drop-zone stage:
  //   - uploaded=true → host slots.dropZoneContent (all post-upload priorities 1-10)
  //   - uploading → DropUploading bytes-in-flight progress
  //   - isDragActive → DropHover
  //   - default → DropIdle
  const dropStage: "idle" | "hover" | "uploading" | "slot" = uploaded
    ? "slot"
    : uploading
      ? "uploading"
      : isDragActive
        ? "hover"
        : "idle";

  // ── Upload page ─────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-3xl pb-12">
      {/* Compact header (design eyebrow + title + sub) */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Upload a document</h1>
        <p className="mt-1.5 text-sm text-slate-500">
          Drop in an EOB, bill, or plan document — we&rsquo;ll extract every line item, audit your charges, and enrich your plan in one pass.
        </p>
      </div>

      {/* SBC upload prompt after plan switch */}
      {needsSbc && (
        <div className="mb-5 flex items-start gap-3 rounded-2xl border border-blue-100 bg-blue-50 p-4">
          <svg className="mt-0.5 h-5 w-5 shrink-0 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <div>
            <p className="text-sm font-semibold text-blue-800">Upload your plan document</p>
            <p className="mt-0.5 text-xs text-blue-600">
              You switched insurance plans. Upload your new Summary of Benefits and Coverage (SBC) so we can populate your benefits.
            </p>
          </div>
        </div>
      )}

      {/* Profile missing banner */}
      {profileMissing && (
        <div className="mb-5 flex items-start gap-3 rounded-2xl border border-blue-100 bg-blue-50 p-4">
          <svg className="mt-0.5 h-5 w-5 shrink-0 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p className="text-sm font-medium text-blue-800">Add your insurance info first</p>
            <p className="mt-0.5 text-xs text-blue-600">Your audit will be more accurate if we know your plan details.</p>
            <Link href="/profile" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900">
              Complete your profile
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>
      )}

      {/* Type selector — D-§1.B.1-A 2-tier (Bill / Plan); wire-type stays 4-doc-type via PICKER_OPTIONS.selectsAs */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(Object.keys(PICKER_OPTIONS) as PickerOptionKey[]).map((pickerKey) => {
          const opt = PICKER_OPTIONS[pickerKey];
          const billFamily: ReadonlyArray<typeof docType> = ["eob", "itemized_bill"];
          const planFamily: ReadonlyArray<typeof docType> = ["sbc", "plan_document"];
          const family = pickerKey === "bill" ? billFamily : planFamily;
          const isActive = family.includes(docType);
          const tone = pickerKey === "bill" ? "peach" : "mint";
          const icon =
            pickerKey === "bill" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            );
          return (
            <TypeCard
              key={pickerKey}
              tone={tone}
              active={isActive}
              icon={icon}
              title={pickerKey === "bill" ? "Bill or EOB" : "Plan document"}
              sub={pickerKey === "bill" ? "An itemized bill or Explanation of Benefits" : "Your SBC, EOC, or plan booklet"}
              onClick={() => {
                if (uploaded || uploading) return;
                setDocType(opt.selectsAs);
                setShowTips(null);
              }}
            />
          );
        })}
      </div>

      {/* Doc-type correction banner (B2-UP.1 #4 UX fix) — visible whenever
          backend Pattern P silently overrode the user's pick at high
          confidence. Tells the user what we detected + where the results
          will land. Stays visible across the post-upload window. */}
      {resolvedDocType && userPickAtUpload && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl border border-amber-100 bg-amber-50 p-4">
          <svg className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-900">
              {resolvedDocType === "eob" || resolvedDocType === "itemized_bill"
                ? "This looked like a bill, so we ran the audit instead."
                : "This looked like a plan document, so we ran plan analysis instead."}
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-amber-800">
              You selected <span className="font-medium">{(userPickAtUpload === "eob" || userPickAtUpload === "itemized_bill") ? "Bill or EOB" : "Plan document"}</span>, but the content matched <span className="font-medium">{(resolvedDocType === "eob" || resolvedDocType === "itemized_bill") ? "a bill" : "a plan document"}</span>. We&rsquo;ll show the results on{" "}
              <span className="font-medium">{(resolvedDocType === "eob" || resolvedDocType === "itemized_bill") ? "/claim" : "/plan"}</span>.
            </p>
          </div>
        </div>
      )}

      {/* HERO drop zone */}
      <div
        {...(dropStage === "idle" || dropStage === "hover" ? getRootProps() : {})}
        className={`relative flex min-h-[280px] flex-col items-center justify-center rounded-2xl border-2 border-dashed p-6 transition-all ${
          dropStage === "hover"
            ? "border-blue-400 bg-blue-50/60"
            : dropStage === "slot"
              ? "border-slate-200 bg-white"
              : "cursor-pointer border-slate-200 bg-slate-50 hover:border-blue-300 hover:bg-blue-50/40"
        }`}
      >
        {(dropStage === "idle" || dropStage === "hover") && <input {...getInputProps()} />}
        {dropStage === "idle" && (
          <DropIdle
            kind={activePickerKey === "bill" ? "bill" : "plan"}
            onPickFile={() => {
              /* useDropzone's getInputProps + click() native opens the picker; getRootProps wraps this container so an outer click triggers it. We can rely on that. */
              const input = (document.querySelector('input[type="file"]') as HTMLInputElement) ?? null;
              input?.click();
            }}
            tipsOpen={showTips === activePickerKey}
            onToggleTips={() =>
              setShowTips((s) => (s === activePickerKey ? null : activePickerKey))
            }
          />
        )}
        {dropStage === "hover" && <DropHover />}
        {dropStage === "uploading" && (
          <DropUploading
            fileName={fileName}
            uploadProgress={uploadProgress}
            onCancel={onCancelInFlight}
          />
        )}
        {dropStage === "slot" && slots.dropZoneContent}
      </div>

      {/* Find-tips panel — visible only during idle + tips toggled open */}
      {dropStage === "idle" && showTips && (
        <FindTipsPanel
          kind={showTips === "bill" ? "bill" : "plan"}
          open={true}
          onClose={() => setShowTips(null)}
          tips={PICKER_OPTIONS[showTips].tips}
        />
      )}

      {/* Cloudflare Turnstile widget — preserve CF-34 mounting behavior.
          Renders when userPickedFile is true; stays mounted while waiting
          for token. The outer shell is always rendered now so the widget
          no longer unmounts when uploaded=true. */}
      {userPickedFile && (
        <div className="mt-4">
          <TurnstileWidget ref={turnstileRef} action="upload" onToken={setTurnstileToken} appearance="execute" />
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-red-100 bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* "Paths" grid — D-§1.B.1-D visibility: visible during idle + done (priorities 8-9); hidden during processing + exceptions */}
      {!slots.hidePathsGrid && (
        <div className="mt-10">
          <div className="mb-4">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              ONE UPLOAD · EVERY SERVICE SHARPER
            </div>
            <h3 className="mt-1 text-base font-semibold text-slate-900">Your document powers all of Candid.</h3>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <PathCard
              tone="peach"
              kind="bill"
              title="Bills feed your Claim audit"
              body="Every line item gets compared to your plan + Medicare benchmarks. Overcharges become draftable dispute letters."
              destLabel="See your audit"
              icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              }
              destination={() => (window.location.href = "/claim")}
            />
            <PathCard
              tone="mint"
              kind="plan"
              title="Plans enrich your Benefits"
              body="We surface every covered benefit you can use, flag HSA / FSA eligibility, and verify each claim against the plan you actually have."
              destLabel="See your benefits"
              icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              }
              destination={() => (window.location.href = "/plan")}
            />
            <PathCard
              tone="lavender"
              kind="plan"
              title="Plans make comparison easy"
              body="Every plan a Candid user uploads keeps our side-by-side comparisons accurate and up to date — so you can pick the plan that actually fits."
              destLabel="Open Compare"
              icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 4h5v16H4zM10 4h5v16h-5zM16 4h4v16h-4z" />
                </svg>
              }
              destination={() => (window.location.href = "/compare")}
            />
            <PathCard
              tone="sky"
              kind="bill"
              title="Bills strengthen Care"
              body="Every bill teaches Candid which providers bill fairly and reimburse cleanly — so when you need care, you can find someone you won't have to dispute later."
              destLabel={candidCareLive ? "See providers" : "Coming soon"}
              icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4.318 6.318a4.5 4.5 0 016.364 0L12 7.636l1.318-1.318a4.5 4.5 0 116.364 6.364L12 20.364l-7.682-7.682a4.5 4.5 0 010-6.364z" />
                </svg>
              }
              destination={candidCareLive ? () => (window.location.href = "/care") : null}
            />
          </div>
        </div>
      )}

      {/* ── Previously uploaded documents (always visible — B14 stuck recovery + general discoverability) ──────────────────────── */}
      {userDocs.length > 0 && (
        <div className="mt-10">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Your uploaded documents</h2>
          <div className="space-y-2">
            {userDocs.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between rounded-xl border border-slate-100 bg-white p-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-50">
                    <svg className="h-4 w-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{doc.file_name}</p>
                    <p className="text-xs text-slate-400">
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
                    className={`rounded-full px-2 py-1 text-xs font-medium ${
                      doc.status === "processed"
                        ? "bg-green-50 text-green-700"
                        : doc.status === "processing" || doc.status === "queued"
                          ? "bg-blue-50 text-blue-700"
                          : doc.status === "pending_review"
                            ? "bg-amber-50 text-amber-700"
                            : doc.status === "error"
                              ? "bg-red-50 text-red-700"
                              : "bg-slate-50 text-slate-500"
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

      {/* "Help us grow" share card — full variant. */}
      <div className="mt-10">
        <ShareWithFriend surface="upload_form" />
      </div>

      {/* Modal slot (priority 0) — renders above everything as full-screen overlay per S99 structural fix */}
      {slots.modal}

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
