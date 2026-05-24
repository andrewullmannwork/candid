/**
 * Dev-only isolated preview for DocTypeConfirmationModal (S121).
 *
 * Triggers the modal directly with mock confirmationData so design iteration
 * doesn't require rolling the classifier confidence dice on real uploads.
 * NODE_ENV-gated: returns 404 in production builds; `/dev/*` namespace exists
 * for future component previews on the same dev-only basis.
 *
 * Usage: visit /dev/doc-type-modal in localhost; click preset buttons to toggle
 * different confirmationData states; modal "Confirm" / "Cancel" / "X" all just
 * close the modal locally (no API calls).
 */

"use client";

import { useState } from "react";
import { notFound } from "next/navigation";
import { DocTypeConfirmationModal } from "@/components/parsing/DocTypeConfirmationModal";
import type {
  DocType,
  DocTypeConfirmation,
} from "@/lib/classifier/doc-type-vocabulary";

type Preset = {
  label: string;
  description: string;
  data: DocTypeConfirmation;
};

const PRESETS: Preset[] = [
  {
    label: "SBC marked as bill (89%)",
    description: "User picked Bill; classifier said SBC at 89% — typical confirmation case.",
    data: {
      user_pick: "eob",
      classifier_pick: "sbc",
      classifier_confidence: 0.89,
      page_count: 10,
      options: ["eob", "sbc"],
    },
  },
  {
    label: "Bill marked as plan (78%)",
    description: "User picked Plan Document; classifier said itemized bill at 78%.",
    data: {
      user_pick: "plan_document",
      classifier_pick: "itemized_bill",
      classifier_confidence: 0.78,
      page_count: 3,
      options: ["plan_document", "itemized_bill"],
    },
  },
  {
    label: "EOC marked as bill (95%)",
    description: "High-confidence case: classifier flags EOC; user picked Bill.",
    data: {
      user_pick: "itemized_bill",
      classifier_pick: "eoc",
      classifier_confidence: 0.95,
      page_count: 47,
      options: ["itemized_bill", "plan_document"],
    },
  },
  {
    label: "SBC marked as bill — low confidence (52%)",
    description: "Edge case at the band floor — barely above the 0.5 threshold.",
    data: {
      user_pick: "eob",
      classifier_pick: "sbc",
      classifier_confidence: 0.52,
      page_count: 8,
      options: ["eob", "sbc"],
    },
  },
];

export default function DocTypeModalPreviewPage() {
  // NODE_ENV guard — page returns 404 in production builds.
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }

  const [activePreset, setActivePreset] = useState<number | null>(0);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const closeModal = () => setActivePreset(null);

  const handleConfirm = async (confirmedDocType: DocType) => {
    setLastAction(`Confirmed: ${confirmedDocType}`);
    closeModal();
  };

  const handleCancel = async () => {
    setLastAction("Cancelled");
    closeModal();
  };

  return (
    <div className="min-h-screen bg-slate-50 p-8">
      <div className="max-w-3xl mx-auto">
        <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-blue-600">
          Dev preview
        </div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight m-0">
          DocTypeConfirmationModal — S121 v3 design
        </h1>
        <p className="mt-2 text-sm text-slate-600 leading-relaxed max-w-2xl">
          Isolated render of the doc-type confirmation modal with mock
          confirmationData. Click a preset to mount the modal; close (X / Cancel
          / Upload a different file) and Confirm just dismiss locally. No API
          calls. Page returns 404 in production builds.
        </p>

        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {PRESETS.map((preset, i) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => {
                setActivePreset(i);
                setLastAction(null);
              }}
              className="text-left bg-white rounded-xl border border-slate-200 hover:border-blue-400 hover:shadow-md transition-all duration-150 p-4 cursor-pointer"
            >
              <div className="text-sm font-bold text-slate-900">
                {preset.label}
              </div>
              <div className="text-xs text-slate-500 mt-1 leading-snug">
                {preset.description}
              </div>
              <div className="mt-3 text-[10px] font-mono text-slate-400 leading-relaxed">
                user_pick: {preset.data.user_pick}
                <br />
                classifier_pick: {preset.data.classifier_pick}
                <br />
                confidence: {preset.data.classifier_confidence}
                <br />
                options: [{preset.data.options.join(", ")}]
              </div>
            </button>
          ))}
        </div>

        {lastAction && (
          <div className="mt-6 inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-200 text-blue-800 text-sm font-medium">
            Last action: {lastAction}
          </div>
        )}

        <div className="mt-10 text-xs text-slate-400 leading-relaxed">
          Source: <code className="font-mono">src/components/parsing/DocTypeConfirmationModal.tsx</code>
          <br />
          Spec: <code className="font-mono">~/Downloads/follow_up_designs_v2 2/extras-doctype-modal/</code>
        </div>
      </div>

      {activePreset !== null && (
        <DocTypeConfirmationModal
          confirmationData={PRESETS[activePreset].data}
          onConfirmDocType={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </div>
  );
}
