"use client";

import { useState } from "react";
import { getConsentDocument } from "@/lib/consent/consent-documents";

/**
 * Simplified onboarding — the health-data consent gate, shared by step 1
 * (insurance-card photo) and step 2 (plan document / bill). Same legal copy,
 * version banner, and explicit-checkbox mechanics as the /upload page modal;
 * one grant covers every upload surface (consent is per-type, not per-file).
 *
 * The card-scan endpoint is not yet server-gated on this consent (that lands
 * in the wizard-cleanup PR once the legacy card step — which has no modal —
 * is deleted); the /onboarding flow still always collects it BEFORE any file
 * leaves the browser, card included, because card images are CHD per the
 * consent document itself.
 */
export function HealthConsentModal({
  open,
  submitting,
  onAccept,
  onCancel,
}: {
  open: boolean;
  submitting: boolean;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const consentDoc = getConsentDocument("health_data_upload");

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl">
        <div className="border-b p-6">
          <h2 className="text-xl font-bold text-gray-900">{consentDoc.title}</h2>
          <p className="mt-1 text-sm text-gray-500">
            Version {consentDoc.version} — Required before uploading health documents
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-gray-700">
            {consentDoc.fullText}
          </pre>
        </div>
        <div className="space-y-4 border-t p-6">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-gray-300"
            />
            <span className="text-sm text-gray-700">
              I have read and understand the above {consentDoc.title} and I explicitly consent to
              its terms.
            </span>
          </label>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => {
                setChecked(false);
                onCancel();
              }}
              className="px-4 py-2 text-gray-600 transition-colors hover:text-gray-800"
            >
              Cancel
            </button>
            <button
              disabled={!checked || submitting}
              onClick={() => {
                setChecked(false);
                onAccept();
              }}
              className="rounded-xl bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Processing..." : "I Accept — Upload"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
