"use client";

import { useState, useCallback, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import { useConsent } from "@/lib/consent/use-consent";
import { getConsentDocument } from "@/lib/consent/consent-documents";

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
    label: "Plan Document (SBC)",
    short: "Plan Document",
    description: "Your Summary of Benefits and Coverage — the official document describing what your plan covers. Helps us provide accurate, plan-specific information.",
    tips: [
      "Log into your insurer's portal and look for 'Plan Documents' or 'Summary of Benefits'",
      "It's usually an 8-page PDF with a standardized format",
      "Your HR department can also provide this if you have employer-sponsored insurance",
    ],
  },
} as const;

// ─── Upload form ────────────────────────────────────────────────────────────

function UploadForm() {
  const { user } = useAuth();
  const [docType, setDocType] = useState<"eob" | "itemized_bill" | "sbc">("eob");
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [showTips, setShowTips] = useState<"eob" | "itemized_bill" | "sbc" | null>(null);
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

  // Consent state — inline, not blocking
  const { hasConsented, loading: consentLoading, grantConsent } = useConsent("health_data_upload");
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [consentSubmitting, setConsentSubmitting] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const consentDoc = getConsentDocument("health_data_upload");

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

      try {
        const idToken = await user.firebaseUser.getIdToken();

        // Upload file via API to bypass RLS
        const formData = new FormData();
        formData.append("file", file);
        formData.append("docType", docType);

        const res = await fetch("/api/documents/upload", {
          method: "POST",
          headers: { Authorization: `Bearer ${idToken}` },
          body: formData,
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          if (errBody.error?.includes("consent")) {
            setError("Health data consent is required. Please try again.");
          } else {
            setError(errBody.error || "Upload failed. Please try again.");
          }
          setUploading(false);
          return;
        }

        const { documentId } = await res.json();

        // For SBC documents, auto-process to extract plan data
        if (docType === "sbc") {
          try {
            const processRes = await fetch("/api/documents/process", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${idToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ documentId, billType: "sbc" }),
            });
            const processData = await processRes.json();
            if (processData.classification) {
              setClassificationResult(processData.classification);
            }
            if (processData.sbcParsed && processData.planData) {
              setSbcParsed(processData.planData);
            }
          } catch {
            // Non-critical: upload succeeded even if processing failed
          }
        } else {
          sessionStorage.setItem(
            "pendingAudit",
            JSON.stringify({ documentId, billType: docType, fileName: file.name })
          );
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

  // ── Success state ───────────────────────────────────────────────────────
  if (uploaded) {
    return (
      <div className="max-w-lg mx-auto">
        <div className="p-6 bg-green-50 border border-green-100 rounded-2xl text-center">
          <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-green-800">Document uploaded</h3>
          <p className="mt-1 text-sm text-green-700">{fileName}</p>

          {/* Classification result */}
          {classificationResult && (
            <div className="mt-3">
              <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${
                classificationResult.mismatch
                  ? "bg-amber-100 text-amber-800"
                  : "bg-blue-100 text-blue-700"
              }`}>
                Detected as: {classificationResult.classifiedType === "sbc" ? "Plan Document (SBC)"
                  : classificationResult.classifiedType === "eob" ? "Explanation of Benefits"
                  : classificationResult.classifiedType === "itemized_bill" ? "Itemized Bill"
                  : classificationResult.classifiedType === "insurance_card" ? "Insurance Card"
                  : classificationResult.classifiedType}
                {classificationResult.confidence > 0 && ` (${Math.round(classificationResult.confidence * 100)}%)`}
              </span>
              {classificationResult.mismatch && (
                <p className="mt-2 text-xs text-amber-700 bg-amber-50 rounded-lg p-2">
                  This document looks different from what you selected. We processed it as your selected type, but results may be more accurate if the type matches.
                </p>
              )}
            </div>
          )}

          {/* SBC parse results */}
          {sbcParsed && (
            <div className="mt-3 text-left bg-green-100 rounded-xl p-3 space-y-1.5">
              <p className="text-xs font-semibold text-green-800">Plan details extracted and saved to your profile</p>
              {sbcParsed.planName && (
                <p className="text-xs text-green-700">Plan: {sbcParsed.planName}</p>
              )}
              <div className="grid grid-cols-2 gap-1 text-xs text-green-700">
                {sbcParsed.inDeductible != null && (
                  <p>In-network deductible: ${sbcParsed.inDeductible.toLocaleString()}</p>
                )}
                {sbcParsed.outDeductible != null && (
                  <p>Out-of-network deductible: ${sbcParsed.outDeductible.toLocaleString()}</p>
                )}
                {sbcParsed.inOopMax != null && (
                  <p>In-network OOP max: ${sbcParsed.inOopMax.toLocaleString()}</p>
                )}
                {sbcParsed.outOopMax != null && (
                  <p>Out-of-network OOP max: ${sbcParsed.outOopMax.toLocaleString()}</p>
                )}
              </div>
              {sbcParsed.servicesExtracted != null && sbcParsed.servicesExtracted > 0 && (
                <p className="text-xs text-green-700">{sbcParsed.servicesExtracted} covered services parsed</p>
              )}
            </div>
          )}

          {!sbcParsed && (
            <p className="mt-3 text-xs text-green-600 bg-green-100 rounded-xl p-3 leading-relaxed">
              Upload more bills for a more complete picture — the more documents we analyze, the better your audit.
            </p>
          )}
          <div className="mt-5 flex flex-col gap-2">
            <button
              onClick={() => {
                setUploaded(false);
                setFileName("");
                setClassificationResult(null);
                setSbcParsed(null);
              }}
              className="w-full py-2.5 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 transition-colors"
            >
              Upload another document
            </button>
            {sbcParsed ? (
              <Link
                href="/plan"
                className="w-full py-2.5 border border-green-200 text-green-700 rounded-xl text-sm font-medium hover:bg-green-50 transition-colors text-center"
              >
                View your plan benefits
              </Link>
            ) : (
              <Link
                href="/audit"
                className="w-full py-2.5 border border-green-200 text-green-700 rounded-xl text-sm font-medium hover:bg-green-50 transition-colors text-center"
              >
                Done uploading — run audit
              </Link>
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
          <div className="grid grid-cols-3 gap-3">
            {(["eob", "itemized_bill", "sbc"] as const).map((type) => {
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
            <>
              <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-600 font-medium">Uploading...</p>
            </>
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
