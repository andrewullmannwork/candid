"use client";

/**
 * Doc-type confirmation modal (S94 B5 + S100 structural fix + S107 v2 styling).
 *
 * Backend halts the upload pipeline at `awaiting_user_confirmation` when the
 * regex classifier disagrees with the user's pick at moderate confidence (band
 * configurable via mig 104). This modal surfaces the disagreement + lets the
 * user pick the correct doc-type to resume the pipeline.
 *
 * S100 structural fix: hoisted out of upload/page.tsx's main form return (where
 * it was unreachable while `uploaded === true` per the S99 bug). Now rendered
 * via ProcessingFlow priority 0 — beats every loader branch, guaranteeing the
 * modal renders whenever the backend halts.
 *
 * S100 copy refinement (Andrew direction): user-facing language uses the picker
 * vocabulary ("Bill" / "Plan Document") instead of internal wire-type acronyms
 * (EOB / SBC / etc.). The two picker classes map 1:1 to the doc-type equivalence
 * classes via `getDocTypeClass()`. The modal's `options` array is always exactly
 * 2 items spanning the 2 classes (per `shouldHaltForUserConfirmation` only
 * halting on cross-class disagreement), so each option renders as one picker
 * card.
 *
 * S107 v2 styling (Claude Design handoff): pill-row footer with explicit
 * "Upload a different file" + "Cancel" + "Confirm" actions. Two-step
 * interaction — clicking a card selects it (blue ring), clicking Confirm
 * commits. Classifier's pick is pre-selected so the common path is a single
 * Confirm click. Both "Upload a different file" and "Cancel" route to
 * onCancel — they're visually distinct affordances for the same action
 * (abort + clear upload state); the parent caller handles either by resetting
 * to the upload picker.
 */
import { useState } from "react";
import {
  type DocType,
  type DocTypeConfirmation,
  getDocTypeClass,
} from "@/lib/classifier/doc-type-vocabulary";

interface DocTypeConfirmationModalProps {
  confirmationData: DocTypeConfirmation;
  /**
   * Called when the user picks an option. Component awaits the promise +
   * tracks local submitting state. Caller is responsible for resuming the
   * pipeline (POST /api/documents/confirm-doc-type action="confirm") + clearing
   * confirmationData on success.
   */
  onConfirmDocType: (confirmedDocType: DocType) => Promise<void>;
  /**
   * Called when the user cancels. Caller is responsible for aborting the
   * pipeline (POST /api/documents/confirm-doc-type action="cancel") + clearing
   * all upload state.
   */
  onCancel: () => Promise<void>;
}

function pickerLabel(docType: string): string {
  const cls = getDocTypeClass(docType);
  if (cls === "bill") return "Bill";
  if (cls === "plan_doc") return "Plan Document";
  return docType;
}

function pickerDescription(docType: string): string {
  const cls = getDocTypeClass(docType);
  if (cls === "bill") {
    return "An EOB or itemized bill from your insurer or provider.";
  }
  if (cls === "plan_doc") {
    return "Your insurance plan documents — SBC, EOC, or full plan certificate.";
  }
  return "";
}

function indefiniteArticle(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function RefreshIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <polyline points="21 3 21 8 16 8" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <polyline points="3 21 3 16 8 16" />
    </svg>
  );
}

export function DocTypeConfirmationModal({
  confirmationData,
  onConfirmDocType,
  onCancel,
}: DocTypeConfirmationModalProps) {
  // Pre-select the option whose class matches the classifier's pick. We can't
  // use classifier_pick directly because it's ClassifierDocType ("eoc" is a
  // possible value that isn't in the user-pickable options array); we match by
  // equivalence class so the "plan_doc" classifier output highlights the
  // "Plan Document" option regardless of which specific wire-type it was.
  const classifierClass = getDocTypeClass(confirmationData.classifier_pick);
  const classifierMatchedOption =
    confirmationData.options.find(
      (opt) => getDocTypeClass(opt) === classifierClass,
    ) ?? confirmationData.options[0];
  const [selectedDocType, setSelectedDocType] = useState<DocType>(
    classifierMatchedOption,
  );
  const [clicked, setClicked] = useState(false);

  const handleConfirm = () => {
    if (clicked) return;
    setClicked(true);
    void onConfirmDocType(selectedDocType);
  };

  const handleCancel = () => {
    if (clicked) return;
    setClicked(true);
    void onCancel();
  };

  const userPickPretty = pickerLabel(confirmationData.user_pick);
  const classifierPickPretty = pickerLabel(confirmationData.classifier_pick);

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="w-[440px] max-w-full bg-white rounded-3xl border border-gray-200 overflow-hidden shadow-[0_24px_60px_-20px_rgba(15,23,42,0.18),0_8px_20px_-8px_rgba(15,23,42,0.08)]">
        <div className="px-7 pt-7 pb-[22px]">
          <h2 className="text-lg font-bold text-gray-900 tracking-[-0.01em] m-0">
            Let&rsquo;s double check your document type
          </h2>
          <p className="text-sm text-gray-500 mt-2 leading-[1.55]">
            You said this is{" "}
            <span className="font-semibold text-gray-900">
              {indefiniteArticle(userPickPretty)} {userPickPretty.toLowerCase()}
            </span>
            , but it looks more like{" "}
            <span className="font-semibold text-gray-900">
              {indefiniteArticle(classifierPickPretty)}{" "}
              {classifierPickPretty.toLowerCase()}
            </span>
            <span className="text-gray-400">
              {" "}
              ({Math.round(confirmationData.classifier_confidence * 100)}%
              confident)
            </span>
            .
          </p>

          <h3 className="text-sm font-bold text-gray-900 mt-5 mb-2.5">
            Which is it?
          </h3>

          <div className="flex flex-col gap-2">
            {confirmationData.options.map((opt) => {
              const isSelected = opt === selectedDocType;
              const isClassifierPick =
                getDocTypeClass(opt) === classifierClass;
              const label = pickerLabel(opt);
              const description = pickerDescription(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  disabled={clicked}
                  onClick={() => setSelectedDocType(opt)}
                  className={`relative w-full text-left px-4 py-[14px] bg-white rounded-2xl border cursor-pointer transition-[border-color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-60 ${
                    isSelected
                      ? "border-blue-600 shadow-[0_0_0_3px_rgba(37,99,235,0.10)]"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                  aria-pressed={isSelected}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[15px] font-bold text-gray-900">
                      {label}
                    </div>
                    {isClassifierPick && (
                      <span className="shrink-0 whitespace-nowrap text-[9px] font-bold tracking-[0.08em] uppercase text-white bg-blue-600 px-2 py-[3px] rounded-full">
                        Our guess
                      </span>
                    )}
                  </div>
                  <p className="text-[13px] text-gray-500 mt-1 leading-normal">
                    {description}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="pt-1 px-[22px] pb-[22px] flex items-center gap-2.5">
          <button
            type="button"
            disabled={clicked}
            onClick={handleCancel}
            className="shrink-0 inline-flex items-center gap-[7px] whitespace-nowrap bg-white hover:bg-gray-50 border border-gray-200 hover:border-gray-300 text-gray-700 text-[13px] font-medium px-3.5 py-2.5 rounded-full cursor-pointer transition-[background-color,border-color] duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshIcon size={13} />
            Upload a different file
          </button>
          <div className="flex-1" />
          <button
            type="button"
            disabled={clicked}
            onClick={handleCancel}
            className="text-gray-500 text-[13px] font-medium px-1.5 py-2.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={clicked}
            onClick={handleConfirm}
            className="glow-blue bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-5 py-2.5 rounded-full cursor-pointer transition-all duration-150 hover:-translate-y-px disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
          >
            Confirm
          </button>
        </div>
      </div>

      <style jsx>{`
        @keyframes fade-in {
          from {
            opacity: 0;
            transform: translateY(8px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        .animate-fade-in > div {
          animation: fade-in 220ms cubic-bezier(0.16, 1, 0.3, 1);
        }
      `}</style>
    </div>
  );
}
