"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { useAuth } from "@/lib/auth/auth-context";
import { TurnstileWidget, type TurnstileWidgetHandle } from "@/components/security/TurnstileWidget";
import { getDocTypeClass, type DocType, type DocTypeConfirmation } from "@/lib/classifier/doc-type-vocabulary";
import { OB_DOC_COPY, type ObChip } from "@/lib/onboarding/simplified";
import { HealthConsentModal } from "./HealthConsentModal";

/** What step 2 stores in flow state. */
export interface DocSlotValue {
  kind: "plan" | "bill" | "background";
  fileName: string | null;
  chips: ObChip[];
}

const fmtMoney = (n: unknown): string | null => {
  const v = typeof n === "number" ? n : typeof n === "string" ? parseFloat(n) : NaN;
  if (!isFinite(v)) return null;
  return `$${Math.round(v).toLocaleString()}`;
};

/**
 * Step 2 — plan document or bill. Single dropzone (design: quiet doc-type
 * explainer instead of an upfront type ask): we submit docType
 * "plan_document" and let the classifier resolve — Pattern P silently
 * overrides confident cases (`resolvedDocType`), and the S94 confirmation
 * prompt handles ambiguous ones in-step.
 *
 * Composes the same production pipeline as /upload (consent v1.6 gate,
 * Turnstile CF-34 mount-on-pick, XHR POST /api/documents/upload, 4s status
 * poll incl. needsTrigger re-fire), with two fixes over the v7 reference:
 *   1. `awaitingDocTypeConfirmation` is checked BEFORE `isLargeDoc` — a large
 *      doc halted for type confirmation must not be released to run in the
 *      background (it would park at awaiting_user_confirmation forever).
 *   2. Canonical-match confirm/reject sends the Authorization header the
 *      server requires for those actions (the v7 call silently never
 *      persisted).
 *
 * Design change vs v7: no mid-flow exit. A parsed plan doc renders coverage
 * chips in-step (POST /api/plan/analyze); a parsed bill renders its audit
 * result in-step (GET /api/claims?documentId=…). Finishing lands on the
 * dashboard, where the meter and the Claim card carry the same results.
 */
export function OnboardingDocStep({
  value,
  onDone,
  onReplace,
  hasConsented,
  grantConsent,
}: {
  value: DocSlotValue | null;
  onDone: (v: DocSlotValue) => void;
  onReplace: () => void;
  hasConsented: boolean;
  grantConsent: () => Promise<void>;
}) {
  const { user } = useAuth();

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [progressPages, setProgressPages] = useState<{ done: number; total: number } | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<DocTypeConfirmation | null>(null);
  const [canonicalMatch, setCanonicalMatch] = useState<{
    canonicalPlanId: string;
    matchedPlanName: string;
    confidence: number;
    sourceCount: number;
    insurerName: string;
  } | null>(null);
  const finalDocTypeRef = useRef<DocType>("plan_document");

  const [showConsent, setShowConsent] = useState(false);
  const [consentSubmitting, setConsentSubmitting] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const [userPickedFile, setUserPickedFile] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileTokenRef = useRef<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);
  useEffect(() => {
    turnstileTokenRef.current = turnstileToken;
  }, [turnstileToken]);

  /* ── In-step result summaries ───────────────────────────────────────────── */

  const summarizePlan = useCallback(async (file: string) => {
    if (!user) return;
    setSummarizing(true);
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/plan/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({}),
      });
      const data = (await res.json().catch(() => ({}))) as {
        totalBenefits?: number;
        planSummary?: { inDeductible?: unknown; inOopMax?: unknown; planType?: string | null };
      };
      const chips: ObChip[] = [];
      const ded = fmtMoney(data.planSummary?.inDeductible);
      const oop = fmtMoney(data.planSummary?.inOopMax);
      if (ded) chips.push({ label: "Deductible", value: ded, verified: true });
      if (oop) chips.push({ label: "OOP max", value: oop, verified: true });
      if (data.planSummary?.planType) chips.push({ label: "Plan type", value: data.planSummary.planType });
      if (typeof data.totalBenefits === "number" && data.totalBenefits > 0) {
        chips.push({ label: "Covered services", value: `${data.totalBenefits} indexed` });
      }
      onDone({ kind: "plan", fileName: file, chips });
    } catch {
      // Parse landed; the summary read is decorative — still mark done.
      onDone({ kind: "plan", fileName: file, chips: [] });
    } finally {
      setSummarizing(false);
    }
  }, [user, onDone]);

  const summarizeBill = useCallback(
    async (file: string, docId: string) => {
      if (!user) return;
      setSummarizing(true);
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch(`/api/claims?documentId=${encodeURIComponent(docId)}&limit=1`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const data = (await res.json().catch(() => ({}))) as {
          claims?: {
            lineItemCount?: number;
            findingCount?: number;
            providerName?: string | null;
            recovery?: { potentialRecovery?: number };
          }[];
        };
        const claim = data.claims?.[0];
        const chips: ObChip[] = [];
        const rec = fmtMoney(claim?.recovery?.potentialRecovery);
        if (rec) chips.push({ label: "Potential recovery", value: rec, verified: true });
        if (typeof claim?.lineItemCount === "number") {
          chips.push({ label: "Line items", value: String(claim.lineItemCount) });
        }
        if (typeof claim?.findingCount === "number") {
          chips.push({ label: "Findings", value: String(claim.findingCount) });
        }
        if (claim?.providerName) chips.push({ label: "Provider", value: claim.providerName });
        onDone({ kind: "bill", fileName: file, chips });
      } catch {
        onDone({ kind: "bill", fileName: file, chips: [] });
      } finally {
        setSummarizing(false);
      }
    },
    [user, onDone],
  );

  const settleProcessed = useCallback(
    (file: string, docId: string | null) => {
      const kind = getDocTypeClass(finalDocTypeRef.current) === "bill" ? "bill" : "plan";
      if (kind === "bill" && docId) void summarizeBill(file, docId);
      else void summarizePlan(file);
    },
    [summarizeBill, summarizePlan],
  );

  /* ── Upload ─────────────────────────────────────────────────────────────── */

  const doUpload = useCallback(
    async (file: File) => {
      if (!user) return;
      setUploading(true);
      setError("");
      setFileName(file.name);
      try {
        const tokenWaitStart = Date.now();
        while (!turnstileTokenRef.current && Date.now() - tokenWaitStart < 12000) {
          await new Promise((r) => setTimeout(r, 200));
        }
        const tokenForUpload = turnstileTokenRef.current;

        const idToken = await user.firebaseUser.getIdToken();
        const formData = new FormData();
        formData.append("file", file);
        formData.append("docType", "plan_document");
        if (tokenForUpload) formData.append("turnstileToken", tokenForUpload);

        setUploadProgress(0);
        const res = await new Promise<Response>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.addEventListener("progress", (e) => {
            if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
          });
          xhr.addEventListener("load", () =>
            resolve(
              new Response(xhr.responseText, {
                status: xhr.status,
                headers: { "content-type": "application/json" },
              }),
            ),
          );
          xhr.addEventListener("error", () => reject(new Error("Upload failed")));
          xhr.open("POST", "/api/documents/upload");
          xhr.setRequestHeader("Authorization", `Bearer ${idToken}`);
          xhr.send(formData);
        });

        turnstileRef.current?.reset();

        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string };
          if (res.status === 403 && errBody.error?.includes("Bot defense")) {
            setError("Bot defense check failed. Please reload the page and try again.");
          } else {
            setError(errBody.error || "Upload failed. Please try again.");
          }
          setUploading(false);
          return;
        }

        const uploadResult = (await res.json()) as {
          documentId?: string;
          resolvedDocType?: string;
          deduplicated?: boolean;
          status?: string;
          isLargeDoc?: boolean;
          awaitingDocTypeConfirmation?: boolean;
          confirmation?: DocTypeConfirmation;
          autoProcessed?: boolean;
          classification?: { pageCount?: number };
          message?: string;
        };
        if (uploadResult.documentId) setDocumentId(uploadResult.documentId);

        finalDocTypeRef.current =
          typeof uploadResult.resolvedDocType === "string"
            ? (uploadResult.resolvedDocType as DocType)
            : "plan_document";

        if (uploadResult.deduplicated === true && uploadResult.status === "processed") {
          setUploading(false);
          settleProcessed(file.name, uploadResult.documentId ?? null);
          return;
        }

        // BUG FIX vs the v7 reference: the doc-type confirmation halt MUST be
        // handled before the large-doc release — a doc can be both, and
        // releasing it un-confirmed parks it at awaiting_user_confirmation
        // with nothing ever queueing it.
        if (uploadResult.awaitingDocTypeConfirmation === true && uploadResult.confirmation) {
          setConfirmation(uploadResult.confirmation);
          setUploading(false);
          return;
        }

        if (uploadResult.isLargeDoc) {
          setUploading(false);
          onDone({ kind: "background", fileName: file.name, chips: [] });
          return;
        }

        if (uploadResult.autoProcessed) {
          setUploading(false);
          setProcessing(true);
          const pageCount = uploadResult.classification?.pageCount ?? 0;
          if (pageCount > 0) setProgressPages({ done: 0, total: pageCount });
        } else if (uploadResult.status === "pending_review") {
          setUploading(false);
          onDone({ kind: "background", fileName: file.name, chips: [] });
        } else if (uploadResult.status === "rejected") {
          setUploading(false);
          setError(
            uploadResult.message ||
              "This document could not be identified as a healthcare document. Try a plan document, bill, or EOB.",
          );
        } else {
          setUploading(false);
          setProcessing(true);
        }
      } catch (err) {
        console.error("[onboarding-upload] error:", err);
        setError("Upload failed. Please try again.");
        setUploading(false);
      }
    },
    [user, onDone, settleProcessed],
  );

  /* ── Status poll (4s + needsTrigger re-fire, same as /upload) ───────────── */

  useEffect(() => {
    if (!documentId || !processing) return;
    let active = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/documents/status?id=${documentId}`);
        if (!res.ok || !active) return;
        const data = (await res.json()) as {
          status?: string;
          totalPages?: number;
          completedPages?: number;
          isStuck?: boolean;
          needsTrigger?: boolean;
          insurerMismatch?: { pending_canonical_match?: typeof canonicalMatch };
        };
        if (typeof data.totalPages === "number" && data.totalPages > 0) {
          setProgressPages({ done: data.completedPages ?? 0, total: data.totalPages });
        }
        if (data.status === "processed") {
          active = false;
          setProcessing(false);
          if (data.insurerMismatch?.pending_canonical_match) {
            setCanonicalMatch(data.insurerMismatch.pending_canonical_match);
            return;
          }
          settleProcessed(fileName, documentId);
          return;
        }
        if (data.status === "pending_review") {
          active = false;
          setProcessing(false);
          onDone({ kind: "background", fileName, chips: [] });
          return;
        }
        if (data.status === "error" || data.isStuck) {
          active = false;
          setProcessing(false);
          setError(
            "We couldn't read that document. Try a clearer copy — or skip for now and add one from your dashboard anytime.",
          );
          setDocumentId(null);
          return;
        }
        if (data.needsTrigger) {
          await fetch("/api/documents/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ documentId }),
          });
        }
      } catch {
        /* retry next tick */
      }
    };
    poll();
    const interval = setInterval(poll, 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [documentId, processing, fileName, onDone, settleProcessed]);

  /* ── Doc-type confirmation ──────────────────────────────────────────────── */

  const confirmDocType = useCallback(
    async (confirmedDocType: DocType) => {
      if (!user || !documentId) return;
      const pageCountHint = confirmation?.page_count ?? null;
      finalDocTypeRef.current = confirmedDocType;
      setConfirmation(null);
      setProcessing(true);
      if (pageCountHint && pageCountHint > 0) setProgressPages({ done: 0, total: pageCountHint });
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
      } catch (err) {
        console.error("[onboarding-upload] doc-type confirmation failed:", err);
        setProcessing(false);
        setError(err instanceof Error ? err.message : "Couldn't confirm document type. Please try again.");
        setDocumentId(null);
      }
    },
    [user, documentId, confirmation],
  );

  /* ── Canonical-match resolve — WITH the required auth header ────────────── */

  const resolveCanonical = useCallback(
    async (action: "confirm_canonical_match" | "reject_canonical_match") => {
      try {
        if (!user || !documentId) throw new Error("missing context");
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/documents/status", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ documentId, action }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          console.error("[onboarding-upload] canonical resolve failed:", body.error);
        }
      } catch (err) {
        console.error("[onboarding-upload] canonical resolve failed:", err);
      }
      setCanonicalMatch(null);
      settleProcessed(fileName, documentId);
    },
    [user, documentId, fileName, settleProcessed],
  );

  /* ── File intake ────────────────────────────────────────────────────────── */

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
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
      setError("");
      setUserPickedFile(true);
      if (hasConsented) {
        void doUpload(file);
      } else {
        setPendingFile(file);
        setShowConsent(true);
      }
    },
    [user, hasConsented, doUpload],
  );

  async function handleConsentAccept() {
    setConsentSubmitting(true);
    try {
      await grantConsent();
      setShowConsent(false);
      if (pendingFile) {
        void doUpload(pendingFile);
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
    disabled: uploading || processing || summarizing || !!confirmation || !!canonicalMatch || !!value,
  });

  /* ── Done state ─────────────────────────────────────────────────────────── */
  if (value) {
    const isBackground = value.kind === "background";
    return (
      <div
        className={`rounded-[18px] border bg-white p-5 shadow-sm ${
          isBackground ? "border-blue-200" : "border-emerald-300"
        }`}
      >
        <div className="flex items-center gap-2.5">
          {isBackground ? (
            <span className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600">
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            </span>
          ) : (
            <span className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
            </span>
          )}
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900">
              {isBackground
                ? "This one will take a few minutes"
                : value.kind === "bill"
                  ? OB_DOC_COPY.parsedBill
                  : OB_DOC_COPY.parsedPlan}
            </p>
            <p className="truncate text-xs text-gray-400">
              {isBackground
                ? "We're reading it in the background — we'll let you know the moment it's ready."
                : value.fileName}
            </p>
          </div>
          {!isBackground && (
            <button
              onClick={onReplace}
              className="ml-auto rounded-lg px-2 py-1 text-xs font-semibold text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            >
              Replace
            </button>
          )}
        </div>
        {value.chips.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {value.chips.map((c, i) => (
              <span
                key={i}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${
                  c.verified
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : "border-gray-200 bg-gray-50 text-gray-600"
                }`}
              >
                <span>{c.label}</span>
                <span className={c.mono ? "font-mono text-[11px]" : "font-bold"}>{c.value}</span>
                {c.verified && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {/* Quiet doc-type explainer (design default: table style) */}
      <div className="mb-5 grid grid-cols-[auto_1fr] items-baseline gap-x-3.5 gap-y-1.5">
        {OB_DOC_COPY.explainer.map((row) => (
          <div key={row.tag} className="contents">
            <div className="text-[10.5px] font-bold tracking-[0.09em] text-gray-400">{row.tag}</div>
            <div className="text-[13px] font-medium text-gray-700">{row.items}</div>
          </div>
        ))}
      </div>

      {confirmation ? (
        <div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">Quick check — what is this document?</p>
          <p className="text-xs leading-relaxed text-amber-700">
            This looks like it might be a different document type than expected. Results land in the
            right place when the type is right.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            {confirmation.options.map((opt) => (
              <button
                key={opt}
                onClick={() => confirmDocType(opt)}
                className={`flex-1 rounded-xl px-3 py-2.5 text-xs font-semibold transition-colors ${
                  opt === confirmation.classifier_pick
                    ? "bg-blue-600 text-white hover:bg-blue-700"
                    : "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                }`}
              >
                {getDocTypeClass(opt) === "bill" ? "It’s a bill / EOB" : "It’s a plan document"}
              </button>
            ))}
          </div>
        </div>
      ) : canonicalMatch ? (
        <div className="space-y-3 rounded-2xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-sm font-semibold text-blue-900">We found a matching plan</p>
          <p className="text-xs leading-relaxed text-blue-700">
            Your document matches a plan already on Candid. Linking gives you community-verified
            benefit data from {canonicalMatch.sourceCount} other{" "}
            {canonicalMatch.sourceCount === 1 ? "member" : "members"}.
          </p>
          <div className="rounded-xl border border-blue-100 bg-white p-3">
            <p className="text-sm font-medium text-gray-900">{canonicalMatch.matchedPlanName}</p>
            <p className="mt-0.5 text-xs text-gray-500">
              {canonicalMatch.insurerName} · {Math.round(canonicalMatch.confidence * 100)}% match
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => resolveCanonical("confirm_canonical_match")}
              className="flex-1 rounded-xl bg-blue-600 px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
            >
              Yes, this is my plan
            </button>
            <button
              onClick={() => resolveCanonical("reject_canonical_match")}
              className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50"
            >
              Not my plan
            </button>
          </div>
        </div>
      ) : uploading || processing || summarizing ? (
        <div className="rounded-[18px] border-2 border-dashed border-gray-300 bg-gradient-to-b from-white to-gray-50 p-8 text-center">
          <div className="mx-auto mb-3 grid h-[46px] w-[46px] place-items-center rounded-full bg-blue-100 text-blue-600">
            <div className="h-[22px] w-[22px] animate-spin rounded-full border-[3px] border-current border-t-transparent opacity-70" />
          </div>
          <p className="text-[15px] font-semibold text-gray-900">
            {uploading ? `Uploading… ${uploadProgress}%` : "Reading your document…"}
          </p>
          <div className="mx-auto mt-3.5 h-1 max-w-[280px] overflow-hidden rounded-full bg-gray-200">
            {uploading || (progressPages && progressPages.total > 0) ? (
              <div
                className="h-full rounded-full bg-blue-500 transition-all"
                style={{
                  width: uploading
                    ? `${uploadProgress}%`
                    : `${Math.round(((progressPages?.done ?? 0) / (progressPages?.total ?? 1)) * 100)}%`,
                }}
              />
            ) : (
              <div className="h-full w-2/5 animate-[obload_1.4s_ease-in-out_infinite] rounded-full bg-blue-500" />
            )}
          </div>
          <p className="mt-2.5 text-xs text-gray-400">
            {progressPages && progressPages.total > 0 && !uploading
              ? `Reading page ${Math.min(progressPages.done + 1, progressPages.total)} of ${progressPages.total}`
              : OB_DOC_COPY.parseNote}
          </p>
        </div>
      ) : (
        <div
          {...getRootProps()}
          className={`flex min-h-[180px] cursor-pointer flex-col items-center justify-center gap-3 rounded-[18px] border-2 border-dashed p-6 text-center transition-all ${
            isDragActive
              ? "border-blue-400 bg-blue-50/60"
              : "border-gray-300 bg-gradient-to-b from-white to-gray-50 hover:border-blue-300 hover:bg-blue-50/40"
          }`}
        >
          <input {...getInputProps()} />
          <span className="inline-flex h-[46px] w-[46px] items-center justify-center rounded-full bg-blue-100 text-blue-600">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
            </svg>
          </span>
          <div>
            <p className="text-[15px] font-semibold text-gray-900">{OB_DOC_COPY.dropTitle}</p>
            <p className="mt-1 text-[13px] text-gray-400">
              or <span className="font-semibold text-blue-600">{OB_DOC_COPY.browse}</span> ·{" "}
              {OB_DOC_COPY.dropSub}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-xl border border-red-100 bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {userPickedFile && (
        <TurnstileWidget ref={turnstileRef} action="upload" onToken={setTurnstileToken} appearance="execute" />
      )}

      <HealthConsentModal
        open={showConsent}
        submitting={consentSubmitting}
        onAccept={handleConsentAccept}
        onCancel={() => {
          setShowConsent(false);
          setPendingFile(null);
        }}
      />
    </>
  );
}
