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
import { PlayfulParsingScreen, type ParseDocPhase } from "@/components/parsing/PlayfulParsingScreen";
import { ShareCandidCard } from "@/components/share/ShareCandidCard";

// ─── Document type info ─────────────────────────────────────────────────────
//
// Two layers (S92 Stage 1):
//
//   1. PICKER_OPTIONS (2 cards) — what the USER sees + clicks. Andrew direction
//      2026-05-14 LOCKED copy: "Bill" + "Plan Document" with explanatory subtitles.
//      Each picker option maps to a default wire-type via `selectsAs`. The
//      classifier + S91 PR #75 resolver (effective-doc-type.ts) handle sub-type
//      routing — if user picks "Bill" but classifier sees a plan_document with
//      high confidence, the resolver overrides to plan_document.
//
//   2. DOC_TYPES (4 wire types) — preserved as the internal wire vocabulary for
//      backward compat with existing parsers + the historic-uploads list at the
//      bottom of the page. The `doc_type` column on `documents` still holds one
//      of these 4 values; resolver decides which.

const PICKER_OPTIONS = {
  bill: {
    label: "Bill",
    short: "Bill",
    description: "An EOB or itemized bill from your insurer or provider",
    selectsAs: "eob" as const,
    tips: [
      "An EOB (Explanation of Benefits) is what your insurer mails or emails after a claim is processed",
      "An itemized bill is from your provider — request one if you only got a summary statement (providers must give you one by law)",
      "Check your insurer's portal under 'Claims' / 'EOBs', or contact your provider's billing department",
    ],
  },
  plan_document: {
    label: "Plan Document",
    short: "Plan Document",
    description: "Your insurance plan documents — SBC, EOC, or plan booklet",
    selectsAs: "plan_document" as const,
    tips: [
      "SBC = Summary of Benefits and Coverage (federally-required 8-page summary you got at enrollment)",
      "EOC = Evidence of Coverage / plan certificate (the longer 50+ page document with the full coverage details)",
      "Log into your insurer's portal under 'Plan Documents', or ask HR if you have employer-sponsored insurance",
    ],
  },
} as const;

type PickerOptionKey = keyof typeof PICKER_OPTIONS;

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

// ─── Expected-duration copy + why-we-take-our-time subtitle ─────────────────
// Doc-type × page-count matrix tuned against measured PROD upload times.
// Empirical floor (S91 measurements with PR #74 Bug X Haiku safety net):
// SBC ~108-140s; small EOB ~30-60s; large EOC (~150 pp) projected 8-12 min.
const WHY_SUBTITLE =
  "We meticulously go over every detail in your plan not once but twice. That takes a while, but we know it's worth it.";

function getExpectedDurationCopy(
  docType: "eob" | "itemized_bill" | "sbc" | "plan_document",
  pages: number | null,
): string {
  const p = pages ?? 0;
  switch (docType) {
    case "eob":
      return "30-60 seconds";
    case "itemized_bill":
      return p >= 30 ? "1-3 minutes" : "30-90 seconds";
    case "sbc":
      return "1-3 minutes";
    case "plan_document":
      if (p >= 100) return "8-12 minutes";
      if (p >= 50) return "5-8 minutes";
      if (p >= 30) return "3-5 minutes";
      return "2-4 minutes";
  }
}

// ─── Upload form ────────────────────────────────────────────────────────────

function UploadForm() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const needsSbc = searchParams.get("need_sbc") === "1";
  // S74.5c §3.1 — consume `?type=<plan|sbc|eob|itemized_bill>` so nudge
  // buttons (e.g., the Case C/D banner on /claim → "Upload plan") pre-select
  // the right doc type. `?type=plan` maps to plan_document; unknown values
  // fall through to the existing `need_sbc` / default branches.
  const typeParam = searchParams.get("type");
  const initialDocType: "eob" | "itemized_bill" | "sbc" | "plan_document" =
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
  const [docType, setDocType] = useState<"eob" | "itemized_bill" | "sbc" | "plan_document">(initialDocType);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<"uploading" | "uploaded" | "auto_processed" | "pending_review" | "rejected" | "dedup_processed" | null>(null);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  // S92 Stage 1: showTips is now per-picker-option (2-card UI), not per-wire-type.
  const [showTips, setShowTips] = useState<PickerOptionKey | null>(null);
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
  // S78 — async ingestion gate: backend sets isLargeDoc=true for PDFs > 30 pages
  // when async_ingestion_ux_v1 feature flag is ON. Drives the large-doc splash
  // copy (personalized page count + duration tier + "Continue browsing" CTA)
  // vs the existing sync PlayfulParsingScreen messaging.
  const [isLargeDoc, setIsLargeDoc] = useState(false);
  const [largeDocPageCount, setLargeDocPageCount] = useState<number | null>(null);
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
    linkedInsurancePlanId?: string | null;
    linkedPlanPremium?: number | null;
  } | null>(null);
  // Track whether the user has saved a premium for the just-uploaded plan
  // (suppresses re-prompting after save + lets the redirect proceed).
  const [premiumSaved, setPremiumSaved] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [yearRolloverEnabled, setYearRolloverEnabled] = useState(false);

  // Rotating status message index — S70 cadence bump from 15s → 4.5s with
  // educational microcopy interleaved per phase (see READING_MESSAGES /
  // EXTRACTING_MESSAGES / INIT_MESSAGES in the progress JSX). Faster cadence
  // makes the long parse latency feel intentional rather than stalled.
  const [messageIndex, setMessageIndex] = useState(0);
  const messageTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // S71 hotfix (Session 73) — minimum-display-time floor for PlayfulParsingScreen.
  // Smart-skip re-uploads complete in 1-3s end-to-end, which made the playful
  // screen flash through without registering. User direction: keep the playful
  // screen visible for every upload, even fast ones. Floor engages when active
  // processing first appears and holds the screen for at least MIN_PLAYFUL_MS
  // total, regardless of how quickly the underlying state transitions to
  // complete. The completion JSX still renders below — just delayed.
  const MIN_PLAYFUL_MS = 4000;
  const [playfulFloorActive, setPlayfulFloorActive] = useState(false);
  const playfulShownAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!uploaded) return;
    // Mirror the render-time derivation of inActiveProcessing so the floor
    // engages/releases on the same signal the render uses.
    const isPendingReview = uploadStatus === "pending_review";
    const isUploadingNow = uploadStatus === "uploading";
    const isProcessingNow = uploadStatus === "auto_processed"
      && processingProgress?.status !== "processed"
      && processingProgress?.status !== "error"
      && !processingProgress?.isStuck;
    const isCompleteNow = processingProgress?.status === "processed"
      && !processingProgress?.insurerMismatch?.mismatch
      && !(yearRolloverEnabled && processingProgress?.insurerMismatch?.year_rollover)
      && !processingProgress?.insurerMismatch?.pending_canonical_match;
    const isErrorNow = processingProgress?.status === "error";
    const isStuckNow = !!processingProgress?.isStuck;
    const hasMismatchNow = processingProgress?.status === "processed" && processingProgress?.insurerMismatch?.mismatch;
    const hasYearRolloverNow = yearRolloverEnabled
      && processingProgress?.status === "processed"
      && !processingProgress?.insurerMismatch?.mismatch
      && !!processingProgress?.insurerMismatch?.year_rollover;
    const hasCanonicalMatchNow = processingProgress?.status === "processed"
      && !processingProgress?.insurerMismatch?.mismatch
      && !hasYearRolloverNow
      && !!processingProgress?.insurerMismatch?.pending_canonical_match;
    // S91 — broaden to `uploaded` (was `isUploadingNow || isProcessingNow`)
    // to mirror the render-time gate, so the floor engages during the transient
    // post-upload pre-poll window too.
    const inActiveNow = uploaded
      && !isCompleteNow && !isErrorNow && !isStuckNow
      && !hasMismatchNow && !hasYearRolloverNow && !hasCanonicalMatchNow
      && !isPendingReview;

    // Error/mismatch/canonical-match/year-rollover bypass the floor — these
    // need to surface immediately so the user can act, not be buried under 4s
    // of "Cross-referencing your plan…" animation.
    if (isErrorNow || isStuckNow || hasMismatchNow || hasCanonicalMatchNow || hasYearRolloverNow) {
      if (playfulFloorActive) {
        setPlayfulFloorActive(false);
        playfulShownAtRef.current = null;
      }
      return;
    }

    // Engage floor on first active state of this upload session.
    if (inActiveNow && playfulShownAtRef.current === null) {
      playfulShownAtRef.current = Date.now();
      setPlayfulFloorActive(true);
      return;
    }

    // When active processing ends but floor is still on, schedule its release
    // when the minimum window elapses.
    if (!inActiveNow && playfulFloorActive && playfulShownAtRef.current !== null) {
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
  }, [uploaded, uploadStatus, processingProgress, yearRolloverEnabled, playfulFloorActive]);

  useEffect(() => {
    const isProcessing = uploaded && uploadStatus === "auto_processed" && !processingProgress?.step?.includes("saving") && processingProgress?.status !== "processed";
    if (isProcessing) {
      messageTimerRef.current = setInterval(() => setMessageIndex((i) => i + 1), 4500);
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
      .eq("target_type", "global")
      .single()
      .then(({ data }) => { if (data?.enabled) setYearRolloverEnabled(true); });
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
  // CF-34 (Session 72): widget render is deferred until the user picks a file
  // (drag/drop or browse) so it doesn't visually clutter the upload form on
  // page load AND we don't waste tokens on visitors who don't actually upload.
  // userPickedFile flips true the moment a valid file is selected; mirror to a
  // ref so doUpload's closure can poll the latest token without stale-deps.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileTokenRef = useRef<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);
  // S91 — XHR ref for the active upload so the X-out cancel button can abort
  // bytes-in-flight. Cleared when the upload settles (success, error, or abort).
  const uploadXhrRef = useRef<XMLHttpRequest | null>(null);
  const [userPickedFile, setUserPickedFile] = useState(false);

  useEffect(() => {
    turnstileTokenRef.current = turnstileToken;
  }, [turnstileToken]);

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
              setTimeout(() => { window.location.href = redirectTarget; }, 1500);
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
      setError("");
      setFileName(file.name);
      // CF-34 (Session 72) FIX v2: do NOT set uploaded=true yet. The form view
      // hosts the TurnstileWidget render (it lives inside the form return; the
      // `if (uploaded)` early-return at line ~484 jumps to the progress view
      // which doesn't render the widget). If we flip uploaded=true now, React
      // unmounts the form → widget never mounts → no token issued → server
      // returns 403 "missing-input-response". Wait for the token BEFORE the
      // flip so the widget has a chance to issue.

      try {
        // Poll up to 12s for Turnstile token. With appearance="execute" + the
        // dev test key the widget issues a token in ~200-800ms; PROD with a
        // real Managed key is similar. The form view stays visible during this
        // wait (dropzone shows the 0% progress bar from setUploading(true)
        // above, so the user sees feedback even while the captcha runs).
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
        // immediately to their results based on doc type, surfacing a clean
        // "your plan/bill is already in your library" outcome.
        if (uploadResult.deduplicated === true && uploadResult.status === "processed") {
          console.log(
            `[upload] dedup-of-processed hit (reason=${uploadResult.deduplicationReason ?? "unspecified"}); routing to results`,
          );
          // Plan-doc family → /plan; bills → /audit (matches existing post-process
          // redirects in this file at lines ~1251, ~1256, ~1355). The form
          // docType is one of {eob, itemized_bill, sbc, plan_document}; EOC
          // documents are uploaded as plan_document and the classifier resolves
          // the EOC sub-type downstream.
          const isPlanDoc = docType === "sbc" || docType === "plan_document";
          const isBill = docType === "eob" || docType === "itemized_bill";
          const target = isPlanDoc ? "/plan" : isBill ? "/audit" : "/dashboard";
          // Brief "Already in your library" toast/state via uploadStatus so the
          // PlayfulParsingScreen unmounts; then navigate via window.location
          // (matches existing pattern in this file).
          setUploadStatus("dedup_processed");
          setUploaded(true);
          setUploading(false);
          // Small delay so the user sees the resolution rather than a flicker;
          // matches the redirect-after-success timing pattern at line ~428.
          setTimeout(() => { window.location.href = target; }, 600);
          return;
        }

        // Backend now handles confidence-gated processing automatically
        if (uploadResult.classification) {
          setClassificationResult(uploadResult.classification);
          // S91 — page count drives duration-copy tier in
          // getExpectedDurationCopy() regardless of async-UX flag state.
          // Decoupled from the isLargeDoc branch below so the copy stays
          // accurate for large EOCs even when async_ingestion_ux_v1 is OFF.
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

  // Intercept drop: validate file, then check consent before uploading.
  // CF-34 (Session 72): also flips userPickedFile so the Turnstile widget
  // mounts at this exact moment — the widget will load + capture a token
  // while the user works through the consent modal (or immediately if already
  // consented), keeping captcha out of the way until it's actually needed.
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
    // Premium prompt: SBCs don't include premium. When parse completes for a
    // plan-type doc with no premium on the linked insurance_plans row, hold
    // the auto-redirect (handled in polling) and surface an inline prompt.
    const needsPremium =
      isPlanType
      && processingProgress?.status === "processed"
      && processingProgress?.linkedPlanPremium == null
      && !premiumSaved;

    // Session 72 bonus: PlayfulParsingScreen for the active upload + parsing
    // phases. Mirrors /compare's progress UX (cleaner shared component) and
    // falls through to the existing completion/error/mismatch JSX once any
    // terminal state lands (premium prompt, action buttons, error retry, etc.
    // all stay on the existing layout).
    //
    // S71 hotfix (Session 73) — also keep the screen visible while
    // playfulFloorActive holds the minimum-display-time floor (smart-skip
    // re-uploads complete in 1-3s otherwise; floor ensures every user sees
    // the playful animation even on fast paths).
    //
    // S91 fix — previously this gated on `(isUploading || isProcessing)` which
    // left a transient window after the upload response settled but before the
    // first /api/documents/status poll returned. During that window uploadStatus
    // was "auto_processed" but processingProgress was still null and both
    // isUploading and isProcessing could read false in certain transitions,
    // dropping the user back into the legacy panel for "Clearing a spot on the
    // desk" microcopy. For fast SBC parses (~10 pages) the window was too brief
    // to catch; for 150-page EOCs going through QStash the gap was multiple
    // seconds. New gate: if the user uploaded a file AND no terminal state has
    // fired, render PlayfulParsingScreen — its own phase logic already handles
    // the queued/parsing/cross_referencing states cleanly.
    const inActiveProcessing =
      uploaded
      && !isComplete
      && !isError
      && !isStuck
      && !hasMismatch
      && !hasYearRollover
      && !hasCanonicalMatch
      && !isPendingReview;
    if (inActiveProcessing || playfulFloorActive) {
      // Floor-only case (active state ended, floor holding screen): present as
      // "cross_referencing" at 95% so it animates as "almost done" rather than
      // freezing at the last upload-progress value.
      const floorOnly = !inActiveProcessing && playfulFloorActive;
      // S93 Bug B fix — terminal "queued" state is bad UX (Andrew direction:
      // "I do not like this change. It should just have the old uploading
      // screen. We don't need to context to queued"). Fallthrough now lands
      // on "parsing" so the PlayfulParsingScreen always renders animated
      // microcopy + moving progress bar between upload-complete and the
      // first chunk-progress event (typically a few seconds for new uploads;
      // longer for backend transient delays). The semantic stretch
      // ("we're already reading" before chunk processing actually starts) is
      // preferred to a static "Queued" pill that feels stuck.
      const phase: ParseDocPhase = floorOnly
        ? "cross_referencing"
        : isUploading
          ? "uploading"
          : processingProgress?.completedPages != null && processingProgress?.totalPages != null
            ? processingProgress?.step?.includes("extracting") || processingProgress?.step?.includes("saving")
              ? "cross_referencing"
              : "parsing"
            : "parsing";
      const playfulProgress = floorOnly
        ? 95
        : isUploading
          ? Math.max(5, uploadProgress)
          : processingProgress?.completedPages != null && processingProgress?.totalPages && processingProgress.totalPages > 0
            ? Math.min(95, 25 + Math.round((processingProgress.completedPages / processingProgress.totalPages) * 60))
            : 25;
      const playfulDetail = floorOnly
        ? "Cross-referencing your plan…"
        : processingProgress?.completedPages != null && processingProgress?.totalPages
          ? `Page ${processingProgress.completedPages} of ${processingProgress.totalPages}`
          : processingProgress?.step ?? undefined;
      // S78 — large-doc async UX: customize title/subtitle/footer when backend
      // flagged the doc as >30-page PDF (and async_ingestion_ux_v1 is ON).
      // Sub-30-page docs continue using the existing sync copy + no footer CTA.
      //
      // S91 — distinguish upload phase (bytes-in-flight, no page count yet,
      // no honest timing estimate) from post-upload reading phase (classification
      // done, page count known, docType-aware timing). During upload phase
      // we don't yet have enough info for an accurate duration — show a
      // neutral "receiving" copy without a misleading time estimate.
      const isUploadingPhase = phase === "uploading";
      const durationCopy = getExpectedDurationCopy(docType, largeDocPageCount);
      const largeDocTitle = isUploadingPhase
        ? "Receiving your document"
        : isLargeDoc
          ? "Thanks — we're reading your plan"
          : "Reading your document";
      const largeDocSubtitle = isUploadingPhase
        ? "Just a moment while we upload your file."
        : isLargeDoc
          ? (() => {
              const pages = largeDocPageCount ?? 0;
              const pagesPhrase = pages > 0 ? `${pages} pages of` : "";
              return `${pagesPhrase ? pagesPhrase + " " : ""}careful extraction takes about ${durationCopy}. Hang tight, browse the rest of Candid, or close the tab — we'll email you the moment it's ready.`;
            })()
          : `Sit tight — this usually takes ${durationCopy}.`;
      // whySubtitle only applies once we're reading the doc — suppress during
      // the bytes-in-flight upload phase since we haven't started reading yet.
      const largeDocWhySubtitle = isUploadingPhase ? undefined : WHY_SUBTITLE;

      // S91 — cancel handler for the X-out button in PlayfulParsingScreen.
      //   - During isUploading: abort the in-flight XHR (truly cancels bytes).
      //   - During processing: POST `action: "cancel"` to /api/documents/status
      //     which sets status='error' + processing_step='canceled_by_user'.
      //     The next process-chunk worker invocation bails at the status gate,
      //     so further QStash chunks become no-ops. Soft cancel — a chunk
      //     currently mid-Haiku-call completes its work, but no chunks fire
      //     after that. Sufficient for the user-perception goal.
      //   - Always: clear local UI state so the user can move on.
      const cancelInFlight = () => {
        if (uploadXhrRef.current) {
          try {
            uploadXhrRef.current.abort();
          } catch {
            /* ignore — XHR already settled */
          }
          uploadXhrRef.current = null;
        }
        // Fire-and-forget backend cancel when a documentId is known. Doesn't
        // need to complete before we clear UI; the worker reads status before
        // each chunk, so once this UPDATE lands the worker will halt.
        if (documentId && user) {
          (async () => {
            try {
              const token = await user.firebaseUser.getIdToken();
              await fetch("/api/documents/status", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
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
      };
      const largeDocFooter = isLargeDoc ? (
        <div className="text-center">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium transition-colors"
          >
            Browse Candid while we work
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </Link>
          <p className="text-xs text-slate-500 mt-3">
            You can leave this tab. We&rsquo;ll email when your plan is ready.
          </p>
        </div>
      ) : undefined;

      return (
        <div className="max-w-2xl mx-auto">
          <PlayfulParsingScreen
            docs={[
              {
                id: documentId ?? "single",
                label: "Your document",
                fileName: fileName || "document.pdf",
                phase,
                progress: playfulProgress,
                detail: playfulDetail,
              },
            ]}
            title={largeDocTitle}
            subtitle={largeDocSubtitle}
            whySubtitle={largeDocWhySubtitle}
            footer={largeDocFooter}
            onCancel={cancelInFlight}
          />
        </div>
      );
    }

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

    // Whimsical doctor's-office vignettes \u2014 keep the wait feel intentional
    // and light without revealing mechanics. Cycles every 4.5s.
    const READING_MESSAGES = [
      "Picking up your document.",
      "Sliding our glasses down to the tip of our nose.",
      "Turning on the desk lamp.",
      "Reading carefully \u2014 page by page.",
      "Doodling a tiny stethoscope in the margin.",
      "Adding a sticky note for later.",
      "Highlighting the important bits in yellow.",
      "Underlining the fine print twice.",
      "Sharpening the #2 pencil. Just the way we like it.",
      "Almost through the stack.",
    ];
    const EXTRACTING_MESSAGES = [
      "Taking notes on the clipboard.",
      "Cross-referencing with the big binder on the shelf.",
      "Stamping a smiley face in the corner.",
      "Tapping the desk thoughtfully.",
      "Drawing a little arrow next to an important number.",
      "Stacking the pages neatly.",
      "Just polishing the apple on the desk.",
    ];
    const INIT_MESSAGES = [
      "Pouring a fresh cup of office coffee.",
      "Getting our reading glasses.",
      "Clearing a spot on the desk.",
    ];

    const getStepLabel = () => {
      if (isUploading) return "Uploading your document...";
      if (isComplete) return "All done!";
      if (isStuck) return "Processing stalled";
      if (isError) return "Processing error";
      if (hasMismatch) return "Review needed";
      if (isPendingReview) return "This one's stumping us";
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

    const legacyDurationCopy = getExpectedDurationCopy(docType, largeDocPageCount);
    const getStepSubtitle = () => {
      if (isComplete || isError || hasMismatch || isPendingReview) return null;
      if (isUploading) return `This usually takes ${legacyDurationCopy}`;
      if (!processingProgress) return `This usually takes ${legacyDurationCopy}`;
      if (processingProgress.step?.startsWith("ocr_chunk") || processingProgress.step?.startsWith("working_ocr"))
        return `This usually takes ${legacyDurationCopy}`;
      if (processingProgress.step === "classifying" || processingProgress.step === "working_classifying")
        return "Almost there...";
      if (processingProgress.step === "extracting" || processingProgress.step === "working_extracting")
        return "This is the exciting part";
      if (processingProgress.step === "saving" || processingProgress.step === "working_saving")
        return "Just a moment more...";
      return null;
    };

    // Step dot positions — aligned with the dots' visual positions in a
    // justify-between flex row (0%, 33%, 66%, ~95%). A dot turns green when
    // the progress bar visually passes it. The next unreached dot pulses.
    const steps = [
      { label: "Upload", threshold: 0 },
      { label: "Read", threshold: 33 },
      { label: "Extract", threshold: 66 },
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
            ) : isError || isStuck || isPendingReview ? (
              <div className={`w-16 h-16 rounded-full ${isError ? "bg-red-50" : "bg-amber-50"} flex items-center justify-center mx-auto mb-4`}>
                <svg className={`w-8 h-8 ${isError ? "text-red-500" : "text-amber-500"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                {(() => {
                  const reached = steps.map((s, i) =>
                    i === 0 ? !isUploading : overallProgress >= s.threshold,
                  );
                  const firstUnreachedIdx = reached.indexOf(false);
                  return steps.map((step, i) => {
                  const isStepComplete = reached[i];
                  const isActive = !isStepComplete && i === firstUnreachedIdx;
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
                  });
                })()}
              </div>
            </div>
          )}

          {/* Pending review */}
          {isPendingReview && (
            <div className="mb-5 p-4 bg-amber-50 border border-amber-100 rounded-xl">
              <p className="text-sm font-medium text-amber-900">
                Couldn&apos;t recognize this document
              </p>
              <p className="text-sm text-amber-800 mt-1.5 leading-relaxed">
                We couldn&apos;t read this well enough to pull benefits. Want to try a different file?
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
                        // S91 Option B — record disambiguation choice for feedback loop
                        void fetch("/api/documents/status", {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${idToken}`,
                          },
                          body: JSON.stringify({
                            documentId,
                            action: "record_disambiguation",
                            choice: "use_this_plan",
                            modalType: "insurer_mismatch",
                          }),
                        }).catch(() => { /* fire-and-forget */ });

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
                    onClick={async () => {
                      // S91 Option B — fire-and-forget disambiguation log before clearing local state
                      if (user && documentId) {
                        const token = await user.firebaseUser.getIdToken().catch(() => null);
                        if (token) {
                          void fetch("/api/documents/status", {
                            method: "POST",
                            headers: {
                              "Content-Type": "application/json",
                              Authorization: `Bearer ${token}`,
                            },
                            body: JSON.stringify({
                              documentId,
                              action: "record_disambiguation",
                              choice: "keep_current",
                              modalType: "insurer_mismatch",
                            }),
                          }).catch(() => { /* fire-and-forget */ });
                        }
                      }
                      setUploaded(false);
                      setUploadStatus(null);
                      setFileName("");
                      setProcessingProgress(null);
                      setDocumentId(null);
                    }}
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
                        // S91 Option B — record disambiguation choice for feedback loop
                        void fetch("/api/documents/status", {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${idToken}`,
                          },
                          body: JSON.stringify({
                            documentId,
                            action: "record_disambiguation",
                            choice: "use_this_plan",
                            modalType: "year_rollover",
                          }),
                        }).catch(() => { /* fire-and-forget */ });

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
                    onClick={async () => {
                      // S91 Option B — fire-and-forget disambiguation log before clearing local state
                      if (user && documentId) {
                        const token = await user.firebaseUser.getIdToken().catch(() => null);
                        if (token) {
                          void fetch("/api/documents/status", {
                            method: "POST",
                            headers: {
                              "Content-Type": "application/json",
                              Authorization: `Bearer ${token}`,
                            },
                            body: JSON.stringify({
                              documentId,
                              action: "record_disambiguation",
                              choice: "keep_current",
                              modalType: "year_rollover",
                            }),
                          }).catch(() => { /* fire-and-forget */ });
                        }
                      }
                      setUploaded(false);
                      setUploadStatus(null);
                      setFileName("");
                      setProcessingProgress(null);
                      setDocumentId(null);
                    }}
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

          {/* Premium prompt — SBCs don't include premium; ask the user before
              they navigate away to /plan so total-cost projections work.
              CF-35 (Session 72): premium is now optional — the inline prompt
              has a Skip button so users who don't know their premium yet can
              proceed without entering a value. They can edit it later from the
              plan page. */}
          {(() => {
            const showPrompt = isComplete && isPlanType && needsPremium && processingProgress?.linkedInsurancePlanId && user && !premiumSaved;
            console.log("[upload] PremiumPromptInline render check:", {
              isComplete,
              isPlanType,
              needsPremium,
              linkedInsurancePlanId: processingProgress?.linkedInsurancePlanId,
              hasUser: !!user,
              premiumSaved,
              showPrompt,
            });
            return showPrompt ? (
              <PremiumPromptInline
                planId={processingProgress!.linkedInsurancePlanId!}
                user={user!}
                onSaved={() => {
                  setPremiumSaved(true);
                  // Session 72 user direction: post-action redirects also go to
                  // /dashboard (consistency with the no-prompt auto-redirect).
                  setTimeout(() => { window.location.href = "/dashboard"; }, 800);
                }}
                onSkip={() => {
                  setPremiumSaved(true);
                  window.location.href = "/dashboard";
                }}
              />
            ) : null;
          })()}

          {/* S90 Bug 2B: medium-confidence supplement prompts. Two
              variants — plan-doc (additive richness) vs bill (verification
              gate before dispute generation). */}
          {isComplete && isPlanType && classificationResult && classificationResult.confidence < 0.8 && (
            <div className="mb-4 p-4 bg-blue-50 border border-blue-100 rounded-xl">
              <p className="text-sm font-medium text-blue-900">
                Good start — add your full plan document for the complete picture
              </p>
              <p className="text-sm text-blue-800 mt-1.5 leading-relaxed">
                We&apos;ve got the basics from your document — but for a complete benefits picture, add your Evidence of Coverage (EOC) or full plan certificate.
              </p>
            </div>
          )}
          {isComplete && (docType === "eob" || docType === "itemized_bill") && classificationResult && classificationResult.confidence < 0.8 && classificationResult.confidence >= 0.6 && (
            <div className="mb-4 p-4 bg-blue-50 border border-blue-100 rounded-xl">
              <p className="text-sm font-medium text-blue-900">
                Review before disputing
              </p>
              <p className="text-sm text-blue-800 mt-1.5 leading-relaxed">
                We processed this — for the most accurate audit, upload your matching {docType === "eob" ? "itemized bill" : "EOB"} and review line items before disputing.
              </p>
            </div>
          )}

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
                onClick={() => { setUploaded(false); setUploadStatus(null); setFileName(""); setClassificationResult(null); setSbcParsed(null); setProcessingProgress(null); setDocumentId(null); setUploadProgress(0); setUserPickedFile(false); setPremiumSaved(false); }}
                className="w-full py-2.5 border border-gray-200 text-gray-700 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors"
              >
                Upload another document
              </button>
            )}
          </div>
        </div>

        {/* "Help us grow" share card — only on successful completion. Hidden
            on error/stuck/pending so the user isn't asked to invite friends
            while their own upload is in a bad state. */}
        {isComplete && <ShareCandidCard surface="upload_complete" />}
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

        {/* Document type selector — S92 Stage 1: 2-card picker. Wire type
            (`docType`) stays as the 4-tuple; picker is just a 2-card visual
            collapse that maps to default wire types via `selectsAs`. */}
        <div>
          <label className="text-sm font-medium text-gray-700 mb-2 block">What are you uploading?</label>
          <div className="grid grid-cols-2 gap-3">
            {(Object.keys(PICKER_OPTIONS) as PickerOptionKey[]).map((pickerKey) => {
              const option = PICKER_OPTIONS[pickerKey];
              // A picker option is "selected" when the current docType matches
              // either the option's default wire-type OR any sub-type that
              // resolves into the same family. Bill family = eob/itemized_bill;
              // Plan family = sbc/plan_document.
              const billFamily: ReadonlyArray<typeof docType> = ["eob", "itemized_bill"];
              const planFamily: ReadonlyArray<typeof docType> = ["sbc", "plan_document"];
              const family = pickerKey === "bill" ? billFamily : planFamily;
              const selected = family.includes(docType);
              // S92 — clicking a card both selects it AND auto-opens its tips
              // panel. Andrew direction 2026-05-14: shouldn't have to click
              // "Where do I find this?" after picking — the tips are part of
              // the answer to the picker prompt. Sub-button still works as a
              // toggle for users who want to hide tips after reading.
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
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") selectAndShowTips(); }}
                  className={`relative p-4 rounded-2xl border-2 text-left transition-all cursor-pointer ${
                    selected
                      ? "border-blue-500 bg-blue-50/50"
                      : "border-gray-200 hover:border-gray-300 bg-white"
                  }`}
                >
                  <p className={`text-sm font-semibold ${selected ? "text-blue-700" : "text-gray-900"}`}>
                    {option.short}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                    {option.description}
                  </p>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setShowTips(showTips === pickerKey ? null : pickerKey); }}
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

        {/* Cloudflare Turnstile — bot defense (S68). Managed mode is invisible
            for legitimate users; high-risk traffic gets an interactive challenge.
            CF-34 (Session 72): widget mounts after the user picks a file AND
            uses appearance="execute" so it stays invisible when Cloudflare
            silently issues a token. The interactive challenge UI only renders
            if Cloudflare actually wants to challenge — never the green Success
            badge that was visually intrusive. doUpload polls turnstileTokenRef
            before sending so a brief delay between mount and token-issuance is
            handled gracefully. */}
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

      {/* "Help us grow" share card — placed on the form view (before upload)
          per user feedback so it's visible while users are deciding whether
          to upload, not only after they've completed one. Also rendered on
          the completion screen below. */}
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

// ── Premium prompt (post-parse, pre-redirect on plan_doc/SBC) ──────────────
//
// Renders in the /upload completion state when SBC parse succeeded but the
// user's insurance_plans row has no premium_monthly. Posts to /api/plan/premium
// (RLS-scoped, ownership-checked). On save, the parent triggers redirect to
// /plan so the new premium powers benefits + comparison views immediately.

function PremiumPromptInline({
  planId,
  user,
  onSaved,
  onSkip,
}: {
  planId: string;
  user: { firebaseUser: { getIdToken(): Promise<string> } };
  onSaved: (premium: number) => void;
  onSkip: () => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    const num = parseFloat(value);
    if (!Number.isFinite(num) || num < 0 || num > 100000) {
      setError("Enter a valid monthly amount.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/plan/premium", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ planId, premiumMonthly: num }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Save failed");
      }
      onSaved(num);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-2xl">
      <p className="text-sm font-semibold text-slate-900">What&rsquo;s your monthly premium?</p>
      <p className="text-xs text-slate-600 mt-1 leading-relaxed">
        SBCs don&rsquo;t include the premium — adding it here unlocks total-cost projections
        and powers Candid Compare. You can always edit this later.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <span className="text-slate-500 text-sm">$</span>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="350.00"
          disabled={saving}
          className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
        />
        <span className="text-slate-500 text-xs">/ month</span>
        <button
          type="button"
          onClick={handleSave}
          disabled={!value || saving}
          className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      <button
        type="button"
        onClick={onSkip}
        disabled={saving}
        className="mt-3 text-xs font-medium text-slate-500 hover:text-slate-900 underline disabled:opacity-50"
      >
        Skip for now — I&rsquo;ll add it later
      </button>
    </div>
  );
}

export default function UploadPage() {
  return <UploadForm />;
}
