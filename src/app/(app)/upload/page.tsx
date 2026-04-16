"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useDropzone } from "react-dropzone";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { useConsent } from "@/lib/consent/use-consent";
import { getConsentDocument } from "@/lib/consent/consent-documents";
import { createBrowserClient } from "@/lib/supabase/client";

// ─── Document type info ─────────────────────────────────────────────────────

const DOC_TYPES = {
  eob: {
    label: "Explanation of Benefits (EOB)",
    short: "EOB",
    description: "The document your insurance company sends after a claim is processed. It shows what was billed, what insurance paid, and what you owe.",
    tips: [
      "Check your insurer's online portal — most EOBs are available digitally",
      "Look for a document titled 'Explanation of Benefits' or 'EOB' in your mail or email",
      "Your EOB is NOT a bill — it's a summary from your insurance company",
    ],
  },
  itemized_bill: {
    label: "Itemized Medical Bill",
    short: "Itemized Bill",
    description: "A detailed bill from your healthcare provider listing every charge by procedure code. This is different from a summary statement.",
    tips: [
      "Call your provider's billing department and ask for an 'itemized statement'",
      "By law, providers must give you an itemized bill if you request one",
      "Look for CPT codes (5-digit numbers) — if you see them, it's itemized",
    ],
  },
  sbc: {
    label: "Summary of Benefits (SBC)",
    short: "SBC",
    description: "Your Summary of Benefits and Coverage — the standardized 8-page document from your insurer describing what your plan covers.",
    tips: [
      "Log into your insurer's portal and look for 'Summary of Benefits and Coverage'",
      "It's a standardized 8-page PDF required by federal law",
      "Your HR department can also provide this if you have employer-sponsored insurance",
    ],
  },
  plan_document: {
    label: "Full Plan Document",
    short: "Plan Doc",
    description: "Your full plan certificate or benefits booklet — the detailed document (often 50+ pages) with all plan rules, covered services, and exclusions.",
    tips: [
      "This is the longer document your insurer or employer provides — not the 8-page SBC",
      "Check your insurer's portal under 'Plan Documents' or 'Certificate of Coverage'",
      "Ask your HR department for the full plan certificate or benefits booklet",
    ],
  },
} as const;

// ─── Upload form ────────────────────────────────────────────────────────────

function UploadForm() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const needsSbc = searchParams.get("need_sbc") === "1";
  const [docType, setDocType] = useState<"eob" | "itemized_bill" | "sbc" | "plan_document">(needsSbc ? "sbc" : "eob");
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<"uploading" | "uploaded" | "auto_processed" | "pending_review" | "rejected" | null>(null);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [showTips, setShowTips] = useState<"eob" | "itemized_bill" | "sbc" | "plan_document" | null>(null);
  const [profileMissing, setProfileMissing] = useState(false);
  const [classificationResult, setClassificationResult] = useState<{
    classifiedType: string;
    confidence: number;
    mismatch: boolean;
  } | null>(null);
  const [sbcParsed, setSbcParsed] = useState<{
    planName?: string;
    inDeductible?: number;
    outDeductible?: number;
    inOopMax?: number;
    outOopMax?: number;
    servicesExtracted?: number;
  } | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [processingProgress, setProcessingProgress] = useState<{
    status: string;
    step: string | null;
    completedPages: number;
    totalPages: number;
    insurerMismatch?: { mismatch: boolean; type?: "insurer" | "plan_name"; existingInsurer?: string; parsedInsurer?: string; existingPlanName?: string; parsedPlanName?: string; pending_canonical_match?: { canonicalPlanId: string; matchedPlanName: string; confidence: number; sourceCount: number; insurerName: string }; year_rollover?: { currentYear: number; newYear: number } } | null;
    processingError?: string | null;
    retryCount?: number;
    isStuck?: boolean;
  } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [yearRolloverEnabled, setYearRolloverEnabled] = useState(false);

  // Rotating status message index — increments every 15s during processing
  const [messageIndex, setMessageIndex] = useState(0);
  const messageTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const isProcessing = uploaded && uploadStatus === "auto_processed" && !processingProgress?.step?.includes("saving") && processingProgress?.status !== "processed";
    if (isProcessing) {
      messageTimerRef.current = setInterval(() => setMessageIndex((i) => i + 1), 15000);
      return () => { if (messageTimerRef.current) clearInterval(messageTimerRef.current); };
    } else {
      if (messageTimerRef.current) clearInterval(messageTimerRef.current);
      messageTimerRef.current = null;
    }
  }, [uploaded, uploadStatus, processingProgress?.step, processingProgress?.status]);

  // Previously uploaded documents
  const [userDocs, setUserDocs] = useState<{ id: string; file_name: string; doc_type: string; status: string; created_at: string; processing_error?: string | null; retry_count?: number }[]>([]);
  const [retryingDocId, setRetryingDocId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const supabase = createBrowserClient();
    supabase
      .from("documents")
      .select("id, file_name, doc_type, status, created_at, processing_error, retry_count")
      .eq("user_id", user.userId)
      .order("created_at", { ascending: false })
      .then(({ data }) => { if (data) setUserDocs(data); });
    // Check feature flag for year rollover UI
    supabase
      .from("feature_flag_rules")
      .select("enabled")
      .eq("flag_key", "plan_year_rollover")
      .eq("scope", "global")
      .single()
      .then(({ data }) => { if (data?.enabled) setYearRolloverEnabled(true); });
  }, [user, uploaded]);

  // Consent state — inline, not blocking
  const { hasConsented, loading: consentLoading, grantConsent } = useConsent("health_data_upload");
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [consentSubmitting, setConsentSubmitting] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const consentDoc = getConsentDocument("health_data_upload");

  // Retry a failed or stuck document
  const retryDocument = useCallback(async (docId: string) => {
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
  }, [user, retrying]);

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
            // No mismatch — redirect to plan page
            setTimeout(() => { window.location.href = "/plan"; }, 1500);
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
    return () => { active = false; clearInterval(interval); };
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
      setUploaded(true); // Immediately show progress page
      setUploadStatus("uploading");
      setError("");
      setFileName(file.name);

      try {
        const idToken = await user.firebaseUser.getIdToken();

        // Upload file via API to bypass RLS
        const formData = new FormData();
        formData.append("file", file);
        formData.append("docType", docType);

        // Use XHR for upload progress tracking
        setUploadProgress(0);
        const res = await new Promise<Response>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.addEventListener("progress", (e) => {
            if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
          });
          xhr.addEventListener("load", () => {
            resolve(new Response(xhr.responseText, { status: xhr.status, headers: { "content-type": "application/json" } }));
          });
          xhr.addEventListener("error", () => reject(new Error("Upload failed")));
          xhr.open("POST", "/api/documents/upload");
          xhr.setRequestHeader("Authorization", `Bearer ${idToken}`);
          xhr.send(formData);
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          if (errBody.error?.includes("consent")) {
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

        // Backend now handles confidence-gated processing automatically
        if (uploadResult.classification) {
          setClassificationResult(uploadResult.classification);
        }

        // Handle different processing outcomes
        if (uploadResult.autoProcessed) {
          // High confidence — processing triggered automatically
          // Client-side polling will drive chunk processing and redirect when done
          setUploadStatus("auto_processed");
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
            JSON.stringify({ documentId: uploadResult.documentId, billType: docType, fileName: file.name })
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
    [user, docType]
  );

  // Intercept drop: validate file, then check consent before uploading
  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (!user || acceptedFiles.length === 0) return;

      const file = acceptedFiles[0];
      const allowedTypes = [
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/heic",
        "image/heif",
      ];
      const isHeic = /\.(heic|heif)$/i.test(file.name);
      if (!allowedTypes.includes(file.type) && !isHeic) {
        setError("Accepted formats: PDF, JPEG, PNG, or HEIC (iPhone photos).");
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        setError("File must be under 20MB.");
        return;
      }

      // If consent already granted, upload immediately
      if (hasConsented) {
        doUpload(file);
      } else {
        // Stash the file and show consent modal
        setPendingFile(file);
        setShowConsentModal(true);
      }
    },
    [user, hasConsented, doUpload]
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

  const typeInfo = DOC_TYPES[docType];

  // ── Progress / Success state — unified flow ─────────────────────────────
  // Shows immediately when upload starts. Combined progress bar for upload + analysis.
  if (uploaded) {
    const isPendingReview = uploadStatus === "pending_review";
    const isUploading = uploadStatus === "uploading";
    const isProcessing = uploadStatus === "auto_processed" && processingProgress?.status !== "processed" && processingProgress?.status !== "error" && !processingProgress?.isStuck;
    const isComplete = processingProgress?.status === "processed" && !processingProgress?.insurerMismatch?.mismatch && !(yearRolloverEnabled && processingProgress?.insurerMismatch?.year_rollover) && !processingProgress?.insurerMismatch?.pending_canonical_match;
    const isError = processingProgress?.status === "error";
    const isStuck = !!processingProgress?.isStuck;
    const canRetry = (isError || isStuck) && (processingProgress?.retryCount || 0) < 3;
    const hasMismatch = processingProgress?.status === "processed" && processingProgress?.insurerMismatch?.mismatch;
    const hasYearRollover = yearRolloverEnabled && processingProgress?.status === "processed" && !processingProgress?.insurerMismatch?.mismatch && !!processingProgress?.insurerMismatch?.year_rollover;
    const hasCanonicalMatch = processingProgress?.status === "processed" && !processingProgress?.insurerMismatch?.mismatch && !hasYearRollover && !!processingProgress?.insurerMismatch?.pending_canonical_match;
    const isPlanType = docType === "sbc" || docType === "plan_document";

    // Calculate unified progress: upload (0-30%), analysis (30-100%)
    const getOverallProgress = () => {
      if (isUploading) return Math.round(uploadProgress * 0.3); // 0-30%
      if (!processingProgress || !processingProgress.totalPages) return 35; // Classifying
      if (processingProgress.step === "classifying" || processingProgress.step === "working_classifying") return 82;
      if (processingProgress.step === "extracting" || processingProgress.step === "working_extracting"
) return 88;
      if (processingProgress.step === "saving" || processingProgress.step === "working_saving") return 95;
      if (isComplete) return 100;
      // OCR chunks: 30-80%
      return 30 + Math.round((processingProgress.completedPages / processingProgress.totalPages) * 50);
    };

    // Playful rotating messages per processing phase
    const READING_MESSAGES = [
      "Picking up your document...",
      "Getting my reading glasses...",
      "Turning on the bedside light...",
      "Reading every page carefully...",
      "Still reading \u2014 this is a long one...",
      "Highlighting the important parts...",
      "Taking notes in the margins...",
      "Almost done reading...",
    ];
    const EXTRACTING_MESSAGES = [
      "Pulling out the good stuff...",
      "Cross-referencing your benefits...",
      "Checking the fine print...",
      "Organizing what we found...",
    ];
    const INIT_MESSAGES = [
      "Getting your document ready...",
      "Getting on my reading glasses...",
      "Warming up the scanner...",
    ];

    const getStepLabel = () => {
      if (isUploading) return "Uploading your document...";
      if (isComplete) return "All done!";
      if (isStuck) return "Processing stalled";
      if (isError) return "Processing error";
      if (hasMismatch) return "Review needed";
      if (isPendingReview) return "Needs a human touch";
      if (!processingProgress) return INIT_MESSAGES[messageIndex % INIT_MESSAGES.length];
      if (processingProgress.step?.startsWith("ocr_chunk") || processingProgress.step?.startsWith("working_ocr"))
        return READING_MESSAGES[messageIndex % READING_MESSAGES.length];
      if (processingProgress.step === "classifying" || processingProgress.step === "working_classifying")
        return "Figuring out what this is...";
      if (processingProgress.step === "extracting" || processingProgress.step === "working_extracting")
        return EXTRACTING_MESSAGES[messageIndex % EXTRACTING_MESSAGES.length];
      if (processingProgress.step === "saving" || processingProgress.step === "working_saving")
        return "Saving your benefits...";
      return "Processing...";
    };

    const getStepSubtitle = () => {
      if (isComplete || isError || hasMismatch || isPendingReview) return null;
      if (isUploading) return "This usually takes about 60 seconds";
      if (!processingProgress) return "This can take a couple minutes for large documents";
      if (processingProgress.step?.startsWith("ocr_chunk") || processingProgress.step?.startsWith("working_ocr"))
        return "This can take a couple minutes for large documents";
      if (processingProgress.step === "classifying" || processingProgress.step === "working_classifying")
        return "Almost there...";
      if (processingProgress.step === "extracting" || processingProgress.step === "working_extracting")
        return "This is the exciting part";
      if (processingProgress.step === "saving" || processingProgress.step === "working_saving")
        return "Just a moment more...";
      return null;
    };

    // Step progress thresholds
    const steps = [
      { label: "Upload", threshold: 0 },
      { label: "Read", threshold: 30 },
      { label: "Extract", threshold: 82 },
      { label: "Save", threshold: 95 },
    ];

    const overallProgress = getOverallProgress();

    return (
      <div className="max-w-lg mx-auto">
        <div className="p-8 bg-white border border-gray-200 rounded-2xl glow-blue relative">
          {/* Close button */}
          <button
            onClick={() => { setUploaded(false); setUploadStatus(null); setFileName(""); setProcessingProgress(null); setDocumentId(null); }}
            className="absolute top-4 left-4 w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          {/* Header */}
          <div className="text-center mb-6">
            {isComplete ? (
              <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            ) : isError || isStuck ? (
              <div className={`w-16 h-16 rounded-full ${isStuck ? "bg-amber-50" : "bg-red-50"} flex items-center justify-center mx-auto mb-4`}>
                <svg className={`w-8 h-8 ${isStuck ? "text-amber-500" : "text-red-500"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
            ) : (
              <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mx-auto mb-4 relative">
                <div className="absolute inset-0 rounded-full border-2 border-blue-200 animate-ping opacity-30" />
                <div className="w-6 h-6 border-[2.5px] border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            <h3 key={getStepLabel()} className="text-xl font-semibold text-gray-900 animate-fade-in">{getStepLabel()}</h3>
            {getStepSubtitle() && (
              <p className="text-sm text-gray-400 mt-1">{getStepSubtitle()}</p>
            )}
            <p className="text-sm text-gray-500 mt-1">{fileName}</p>
          </div>

          {/* Combined progress bar (uploading + analyzing) */}
          {!isComplete && !isError && !isStuck && !hasMismatch && !isPendingReview && (
            <div className="mb-6">
              <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-blue-500 to-blue-600 rounded-full transition-all duration-700 ease-out"
                  style={{ width: `${Math.max(3, overallProgress)}%` }}
                />
              </div>
              {/* Step indicators — pill style */}
              <div className="flex justify-between mt-4">
                {steps.map((step, i) => {
                  const isStepComplete = overallProgress > step.threshold || (i === 0 && overallProgress >= 0 && !isUploading);
                  const isActive = i === 0
                    ? isUploading
                    : overallProgress >= step.threshold && (i === steps.length - 1 || overallProgress < steps[i + 1].threshold);
                  return (
                    <div key={step.label} className="flex items-center gap-1.5">
                      <span className="w-4 h-4 flex items-center justify-center">
                        {isStepComplete && !isActive ? (
                          <svg className="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                        ) : isActive ? (
                          <span className="relative flex h-2.5 w-2.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500" />
                          </span>
                        ) : (
                          <span className="h-2.5 w-2.5 rounded-full bg-gray-200" />
                        )}
                      </span>
                      <span className={`text-xs font-medium ${
                        isActive ? "text-blue-600" : isStepComplete ? "text-green-600" : "text-gray-400"
                      }`}>
                        {step.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Pending review */}
          {isPendingReview && (
            <div className="mb-5 p-4 bg-amber-50 border border-amber-100 rounded-xl">
              <p className="text-sm font-medium text-amber-900">
                We need a little more time
              </p>
              <p className="text-sm text-amber-800 mt-1.5 leading-relaxed">
                Our document reader is working on your plan but needs a bit longer than usual.
                We&apos;ll email you when your results are ready, or you can try uploading again.
              </p>
              <button
                onClick={() => { setUploaded(false); setUploadStatus(null); setFileName(""); setProcessingProgress(null); setDocumentId(null); }}
                className="mt-3 w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors"
              >
                Try again
              </button>
            </div>
          )}

          {/* Error state */}
          {isError && (
            <div className="mb-5 p-4 bg-red-50 border border-red-100 rounded-xl">
              <p className="text-sm font-medium text-red-800">
                {processingProgress?.processingError || "Something went wrong during analysis."}
              </p>
              {canRetry ? (
                <>
                  <p className="text-xs text-red-600 mt-1">
                    Retry {processingProgress?.retryCount || 0} of 3
                  </p>
                  <button
                    onClick={() => documentId && retryDocument(documentId)}
                    disabled={retrying}
                    className="mt-3 w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50"
                  >
                    {retrying ? "Retrying..." : "Try again"}
                  </button>
                </>
              ) : (
                <p className="text-xs text-red-600 mt-1">Maximum retries reached. Please contact support or try uploading a different document.</p>
              )}
            </div>
          )}

          {/* Stuck state */}
          {isStuck && (
            <div className="mb-5 p-4 bg-amber-50 border border-amber-100 rounded-xl">
              <p className="text-sm font-medium text-amber-900">Processing seems stuck</p>
              <p className="text-sm text-amber-800 mt-1">Your document has been processing for a while without progress.</p>
              {canRetry ? (
                <button
                  onClick={() => documentId && retryDocument(documentId)}
                  disabled={retrying}
                  className="mt-3 w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50"
                >
                  {retrying ? "Retrying..." : "Retry processing"}
                </button>
              ) : (
                <p className="text-xs text-amber-700 mt-1">Maximum retries reached. Please contact support.</p>
              )}
            </div>
          )}

          {/* Insurer or plan name mismatch prompt */}
          {hasMismatch && processingProgress?.insurerMismatch && (() => {
            const mm = processingProgress.insurerMismatch;
            const isPlanMismatch = mm.type === "plan_name";
            const existingLabel = isPlanMismatch ? mm.existingPlanName : mm.existingInsurer;
            const newLabel = isPlanMismatch ? mm.parsedPlanName : mm.parsedInsurer;
            return (
              <div className="mb-5 p-5 bg-amber-50 border border-amber-200 rounded-2xl">
                <p className="text-sm font-semibold text-gray-900 mb-3">
                  {isPlanMismatch
                    ? "This document is for a different plan"
                    : "This document is from a different insurer"
                  }
                </p>

                {/* Current plan card */}
                <div className="p-3 bg-white border border-gray-200 rounded-xl mb-2">
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">On your card</p>
                  <p className="text-sm font-medium text-gray-900 mt-0.5">{existingLabel}</p>
                </div>

                {/* New plan card */}
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl mb-4">
                  <p className="text-[10px] font-semibold text-blue-500 uppercase tracking-wide">In this document</p>
                  <p className="text-sm font-medium text-gray-900 mt-0.5">{newLabel}</p>
                </div>

                <div className="flex flex-col gap-2">
                  <button
                    onClick={async () => {
                      if (!user) return;
                      try {
                        const idToken = await user.firebaseUser.getIdToken();
                        const profileUpdate: Record<string, string> = {};
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
                            // Redirect to profile with card re-scan prompt
                            window.location.href = "/profile?rescan_card=1";
                            return;
                          }
                        }

                        window.location.href = "/plan";
                      } catch (err) {
                        console.error("Activation error:", err);
                        setError("Failed to activate plan. Please try again.");
                      }
                    }}
                    className="w-full py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors"
                  >
                    Use this plan
                  </button>
                  <button
                    onClick={() => { setUploaded(false); setUploadStatus(null); setFileName(""); setProcessingProgress(null); setDocumentId(null); }}
                    className="w-full py-2.5 border border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors"
                  >
                    Keep my current plan
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Plan year rollover prompt */}
          {hasYearRollover && processingProgress?.insurerMismatch?.year_rollover && (() => {
            const yr = processingProgress.insurerMismatch!.year_rollover!;
            return (
              <div className="mb-5 p-5 bg-blue-50 border border-blue-200 rounded-2xl">
                <p className="text-sm font-semibold text-gray-900 mb-2">
                  New plan year detected
                </p>
                <p className="text-xs text-gray-600 mb-4">
                  This document is for your <strong>{yr.newYear}</strong> plan. Your current plan is from <strong>{yr.currentYear}</strong>. Switching will activate your {yr.newYear} benefits and reset your deductible progress.
                </p>

                <div className="flex items-center gap-2 mb-4">
                  <div className="flex-1 p-3 bg-white border border-gray-200 rounded-xl">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Current</p>
                    <p className="text-sm font-medium text-gray-900 mt-0.5">{yr.currentYear} Plan</p>
                  </div>
                  <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                  <div className="flex-1 p-3 bg-blue-100 border border-blue-200 rounded-xl">
                    <p className="text-[10px] font-semibold text-blue-500 uppercase tracking-wide">New</p>
                    <p className="text-sm font-medium text-gray-900 mt-0.5">{yr.newYear} Plan</p>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <button
                    onClick={async () => {
                      if (!user) return;
                      try {
                        const idToken = await user.firebaseUser.getIdToken();
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
                    }}
                    className="w-full py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors"
                  >
                    Switch to {yr.newYear} plan
                  </button>
                  <button
                    onClick={() => { setUploaded(false); setUploadStatus(null); setFileName(""); setProcessingProgress(null); setDocumentId(null); }}
                    className="w-full py-2.5 border border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors"
                  >
                    Keep {yr.currentYear} plan
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Canonical plan match confirmation */}
          {hasCanonicalMatch && processingProgress?.insurerMismatch?.pending_canonical_match && (() => {
            const cm = processingProgress.insurerMismatch!.pending_canonical_match!;
            return (
              <div className="mb-5 p-5 bg-indigo-50 border border-indigo-200 rounded-2xl">
                <p className="text-sm font-semibold text-gray-900 mb-3">
                  We found a matching plan record
                </p>

                <div className="p-3 bg-white border border-indigo-200 rounded-xl mb-4">
                  <p className="text-[10px] font-semibold text-indigo-500 uppercase tracking-wide">Matched plan</p>
                  <p className="text-sm font-medium text-gray-900 mt-0.5">{cm.matchedPlanName}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{cm.insurerName}</p>
                  {cm.sourceCount > 1 && (
                    <p className="text-xs text-indigo-600 mt-1">{cm.sourceCount} other member{cm.sourceCount === 1 ? "" : "s"} uploaded this plan</p>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <button
                    onClick={async () => {
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
                    }}
                    className="w-full py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors"
                  >
                    Yes, this is my plan
                  </button>
                  <button
                    onClick={async () => {
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
                    }}
                    className="w-full py-2.5 border border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors"
                  >
                    No, different plan
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Action buttons */}
          <div className="flex flex-col gap-2">
            {isComplete && isPlanType && (
              <Link
                href="/plan"
                className="w-full py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors text-center"
              >
                View your benefits
              </Link>
            )}
            {isComplete && !isPlanType && (
              <Link
                href="/audit"
                className="w-full py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors text-center"
              >
                Run audit
              </Link>
            )}
            {(isComplete || isError || isStuck || isPendingReview) && (
              <button
                onClick={() => { setUploaded(false); setUploadStatus(null); setFileName(""); setClassificationResult(null); setSbcParsed(null); setProcessingProgress(null); setDocumentId(null); setUploadProgress(0); }}
                className="w-full py-2.5 border border-gray-200 text-gray-700 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors"
              >
                Upload another document
              </button>
            )}
          </div>
        </div>
      </div>
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
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p className="text-sm font-medium text-blue-800">Add your insurance info first</p>
            <p className="text-xs text-blue-600 mt-0.5">
              Your audit will be more accurate if we know your plan details.
            </p>
            <Link
              href="/profile"
              className="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-blue-700 hover:text-blue-900"
            >
              Complete your profile
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>
      )}

      <div className="mt-6 space-y-5">

        {/* Document type selector */}
        <div>
          <label className="text-sm font-medium text-gray-700 mb-2 block">What are you uploading?</label>
          <div className="grid grid-cols-2 gap-3">
            {(["eob", "itemized_bill", "sbc", "plan_document"] as const).map((type) => {
              const info = DOC_TYPES[type];
              const selected = docType === type;
              return (
                <div
                  key={type}
                  role="button"
                  tabIndex={0}
                  onClick={() => setDocType(type)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setDocType(type); }}
                  className={`relative p-4 rounded-2xl border-2 text-left transition-all cursor-pointer ${
                    selected
                      ? "border-blue-500 bg-blue-50/50"
                      : "border-gray-200 hover:border-gray-300 bg-white"
                  }`}
                >
                  <p className={`text-sm font-semibold ${selected ? "text-blue-700" : "text-gray-900"}`}>
                    {info.short}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                    {info.description.slice(0, 80)}...
                  </p>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setShowTips(showTips === type ? null : type); }}
                    className="mt-2 text-[11px] font-medium text-blue-600 hover:text-blue-700"
                  >
                    {showTips === type ? "Hide tips" : "Where do I find this?"}
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
                How to find your {DOC_TYPES[showTips].short}
              </p>
              <ul className="space-y-1.5">
                {DOC_TYPES[showTips].tips.map((tip, i) => (
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
            isDragActive
              ? "border-blue-400 bg-blue-50"
              : "border-gray-200 bg-gray-50 hover:border-blue-300 hover:bg-blue-50/50"
          } ${uploading ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <input {...getInputProps()} />
          {uploading ? (
            <div className="w-full max-w-[240px] text-center">
              <p className="text-sm text-gray-600 font-medium mb-2">Uploading{uploadProgress < 100 ? "..." : " complete"}</p>
              <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-600 rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="text-xs text-gray-400 mt-1.5">{fileName} — {uploadProgress}%</p>
            </div>
          ) : isDragActive ? (
            <>
              <div className="w-12 h-12 rounded-2xl bg-blue-100 flex items-center justify-center">
                <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
              </div>
              <p className="text-sm font-medium text-blue-600">Drop your PDF here</p>
            </>
          ) : (
            <>
              <div className="w-12 h-12 rounded-2xl bg-blue-100 flex items-center justify-center">
                <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
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
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
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
                  <span className={`text-xs font-medium px-2 py-1 rounded-full ${
                    doc.status === "processed" ? "bg-green-50 text-green-700" :
                    doc.status === "processing" || doc.status === "queued" ? "bg-blue-50 text-blue-700" :
                    doc.status === "pending_review" ? "bg-amber-50 text-amber-700" :
                    doc.status === "error" ? "bg-red-50 text-red-700" :
                    "bg-gray-50 text-gray-500"
                  }`}>
                    {doc.status === "processed" ? "Processed" :
                     doc.status === "processing" ? "Processing" :
                     doc.status === "queued" ? "Queued" :
                     doc.status === "pending_review" ? "Under review" :
                     doc.status === "error" ? "Error" :
                     "Uploaded"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Inline consent modal — shown on first upload attempt ─────────── */}
      {showConsentModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[80vh] flex flex-col shadow-2xl">
            <div className="p-6 border-b">
              <h2 className="text-xl font-bold text-gray-900">{consentDoc.title}</h2>
              <p className="text-sm text-gray-500 mt-1">Version {consentDoc.version} — Required before uploading health documents</p>
            </div>

            <div className="p-6 overflow-y-auto flex-1">
              <pre className="whitespace-pre-wrap font-sans text-sm text-gray-700 leading-relaxed">
                {consentDoc.fullText}
              </pre>
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
