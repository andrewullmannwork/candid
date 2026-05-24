"use client";

/**
 * Doc-type confirmation modal (S94 B5 + S100 structural fix + S107 v2 styling +
 * S121 v3 design refresh).
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
 * S121 v3 design refresh: amber top accent + icon-plate header + close X +
 * "DOC-TYPE MISMATCH DETECTED" eyebrow + inline amber confidence pill + explicit
 * radio dots on option cards + shadow on "OUR GUESS" pill + border-top footer
 * divider + mobile column-reverse stack. Two-step interaction preserved
 * (classifier pick pre-selected; Confirm commits). Cancel button + "Upload a
 * different file" pill + close X all route to onCancel.
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

function WarningIcon({ size = 22 }: { size?: number }) {
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
      <path d="M12 9v2m0 4h.01m-6.9 4h13.8c1.5 0 2.5-1.7 1.7-2.5L13.7 4c-.8-.8-2-.8-2.7 0L4.1 16.5c-.8.8.2 2.5 1.7 2.5z" />
    </svg>
  );
}

function CloseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function CheckIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
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
  const confidencePct = Math.round(confirmationData.classifier_confidence * 100);

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="w-full max-w-[480px] bg-white rounded-[22px] overflow-hidden border-t-[3px] border-amber-500 shadow-[0_30px_80px_-20px_rgba(15,23,42,0.35),0_8px_24px_-12px_rgba(15,23,42,0.15)]">
        {/* Head */}
        <div className="px-6 pt-[22px] pb-1">
          <div className="flex justify-between items-start mb-3">
            <div className="w-11 h-11 rounded-xl bg-amber-100 text-amber-700 grid place-items-center shadow-[inset_0_0_0_1px_#fde68a]">
              <WarningIcon size={22} />
            </div>
            <button
              type="button"
              disabled={clicked}
              onClick={handleCancel}
              aria-label="Close"
              className="w-[30px] h-[30px] rounded-lg bg-gray-100 hover:bg-gray-200 grid place-items-center text-gray-500 hover:text-gray-900 cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CloseIcon size={14} />
            </button>
          </div>
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-amber-700">
            Doc-type mismatch detected
          </div>
          <h2 className="mt-1 text-xl font-bold text-gray-900 tracking-[-0.015em] leading-[1.25] m-0">
            Let&rsquo;s double-check your document type
          </h2>
          <p className="mt-2 text-[13.5px] text-gray-600 leading-[1.6]">
            You said this is{" "}
            <strong className="font-bold text-gray-900">
              {indefiniteArticle(userPickPretty)} {userPickPretty.toLowerCase()}
            </strong>
            , but it looks more like{" "}
            <strong className="font-bold text-gray-900">
              {indefiniteArticle(classifierPickPretty)}{" "}
              {classifierPickPretty.toLowerCase()}
            </strong>
            <span className="inline-flex items-center gap-[5px] ml-1 align-baseline text-[11px] font-bold uppercase tracking-[0.04em] px-2 py-[2px] rounded-full bg-amber-100 text-amber-700 shadow-[inset_0_0_0_1px_#fde68a]">
              {confidencePct}% Confident
            </span>
            .
          </p>
        </div>

        {/* Body */}
        <div className="px-6 pt-4 pb-1">
          <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-gray-400 mb-2.5">
            Which is it?
          </div>
          <div className="flex flex-col gap-2.5">
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
                  aria-pressed={isSelected}
                  className={`relative w-full bg-white rounded-[14px] border-[1.5px] px-4 py-[14px] cursor-pointer text-left flex gap-3 items-start transition-[border-color,background-color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-60 ${
                    isSelected
                      ? "border-blue-600 bg-gradient-to-b from-white to-blue-50 shadow-[0_0_0_3px_rgba(37,99,235,0.08)]"
                      : "border-gray-200 hover:border-blue-300"
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-full border-[1.5px] grid place-items-center flex-shrink-0 mt-0.5 text-white transition-all duration-150 ${
                      isSelected
                        ? "bg-blue-600 border-blue-600"
                        : "bg-white border-gray-300"
                    }`}
                  >
                    {isSelected && <CheckIcon size={10} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[14.5px] font-bold text-gray-900 tracking-[-0.005em]">
                        {label}
                      </div>
                      {isClassifierPick && (
                        <span className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-white bg-blue-600 px-2 py-[3px] rounded-full whitespace-nowrap shadow-[0_4px_10px_-4px_rgba(37,99,235,0.35)]">
                          Our guess
                        </span>
                      )}
                    </div>
                    <p className="text-[12.5px] text-gray-500 mt-[3px] leading-[1.5]">
                      {description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 pt-4 pb-[22px] mt-2 border-t border-gray-100 max-[720px]:flex-col-reverse max-[720px]:items-stretch">
          <div className="shrink-0 max-[720px]:w-full">
            <button
              type="button"
              disabled={clicked}
              onClick={handleCancel}
              className="inline-flex items-center gap-[7px] whitespace-nowrap bg-transparent border border-gray-200 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 text-gray-600 text-[12.5px] font-semibold px-3.5 py-2 rounded-[10px] cursor-pointer transition-[border-color,color,background-color] duration-150 disabled:opacity-50 disabled:cursor-not-allowed max-[720px]:w-full max-[720px]:justify-center"
            >
              <RefreshIcon size={13} />
              Upload a different file
            </button>
          </div>
          <div className="flex gap-2 items-center max-[720px]:w-full">
            <button
              type="button"
              disabled={clicked}
              onClick={handleCancel}
              className="text-gray-500 hover:text-gray-700 text-[13px] font-medium px-3 py-2.5 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed max-[720px]:flex-1"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={clicked}
              onClick={handleConfirm}
              className="glow-blue bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-5 py-2.5 rounded-full cursor-pointer transition-all duration-150 hover:-translate-y-px disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 max-[720px]:flex-1"
            >
              Confirm
            </button>
          </div>
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
