"use client";

import { useState, type ReactNode } from "react";
import { useConsent } from "./use-consent";
import { getConsentDocument } from "./consent-documents";
import type { ConsentType } from "@/lib/supabase/types";

interface ConsentGateProps {
  /** The consent type required to access the children */
  type: ConsentType;
  /** Content to render when consent has been granted */
  children: ReactNode;
  /** Optional message shown when user declines */
  declineMessage?: string;
}

export function ConsentGate({ type, children, declineMessage }: ConsentGateProps) {
  const { hasConsented, needsReconsent, loading, grantConsent } = useConsent(type);
  const [showModal, setShowModal] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checked, setChecked] = useState(false);

  const consentDoc = getConsentDocument(type);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-gray-500">Checking consent status...</div>
      </div>
    );
  }

  if (hasConsented) {
    return <>{children}</>;
  }

  // Auto-show modal if consent is needed and not yet shown
  if (!showModal && !declined) {
    return (
      <div className="flex flex-col items-center justify-center p-8 space-y-4">
        <h3 className="text-lg font-semibold">{consentDoc.title} Required</h3>
        <p className="text-gray-600 text-center max-w-md">
          {needsReconsent
            ? `Our ${consentDoc.title} has been updated. Please review and accept the new version to continue.`
            : consentDoc.summary}
        </p>
        <button
          onClick={() => setShowModal(true)}
          className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          Review & Accept
        </button>
      </div>
    );
  }

  if (declined) {
    return (
      <div className="flex flex-col items-center justify-center p-8 space-y-4">
        <h3 className="text-lg font-semibold">Consent Required</h3>
        <p className="text-gray-600 text-center max-w-md">
          {declineMessage ||
            `You must accept the ${consentDoc.title} to access this feature. You can change your mind at any time.`}
        </p>
        <button
          onClick={() => {
            setDeclined(false);
            setShowModal(true);
          }}
          className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          Review Again
        </button>
      </div>
    );
  }

  // Consent modal
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
        <div className="p-6 border-b">
          <h2 className="text-xl font-bold">{consentDoc.title}</h2>
          <p className="text-sm text-gray-500 mt-1">Version {consentDoc.version}</p>
        </div>

        <div className="p-6 overflow-y-auto flex-1">
          <pre className="whitespace-pre-wrap font-sans text-sm text-gray-700 leading-relaxed">
            {consentDoc.fullText}
          </pre>
        </div>

        <div className="p-6 border-t space-y-4">
          {/* Explicit checkbox — NOT passive acceptance */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-gray-300"
            />
            <span className="text-sm text-gray-700">
              I have read and understand the above {consentDoc.title} and I explicitly consent to its
              terms.
            </span>
          </label>

          <div className="flex gap-3 justify-end">
            <button
              onClick={() => {
                setShowModal(false);
                setDeclined(true);
                setChecked(false);
              }}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 transition-colors"
            >
              Decline
            </button>
            <button
              disabled={!checked || submitting}
              onClick={async () => {
                setSubmitting(true);
                try {
                  await grantConsent();
                  setShowModal(false);
                } catch (err) {
                  console.error("Consent grant failed:", err);
                } finally {
                  setSubmitting(false);
                }
              }}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? "Processing..." : "I Accept"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
