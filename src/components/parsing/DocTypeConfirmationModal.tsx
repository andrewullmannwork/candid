"use client";

/**
 * Doc-type confirmation modal (S94 B5 + S100 structural fix).
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
 * Pure presentational — submitting state local (tracks which option is
 * in-flight so we can show a spinner on the clicked button + disable siblings).
 * Caller passes async onConfirmDocType + onCancel callbacks.
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

// ─── Picker-language presentation (Andrew direction S100) ──────────────────
//
// Maps wire-type doc types to the 2-card picker vocabulary used in the upload
// form. Avoids surfacing internal acronyms (SBC, EOB, etc.) at the user-facing
// modal layer — keeps presentation consistent with the picker the user clicked
// on the upload page.

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

export function DocTypeConfirmationModal({
  confirmationData,
  onConfirmDocType,
  onCancel,
}: DocTypeConfirmationModalProps) {
  // Single multi-click guard — parent owns optimistic state transition + API
  // call. Modal unmounts within one render after the first click, so the guard
  // mostly defends against duplicate-clicks during the same frame.
  const [clicked, setClicked] = useState(false);

  const handleConfirm = (opt: DocType) => {
    if (clicked) return;
    setClicked(true);
    // Fire-and-forget — parent does optimistic setUploadStatus("auto_processed")
    // + setConfirmationData(null), which unmounts this modal on next render.
    // API call runs in parallel inside the parent's callback; failure surfaces
    // via the form-view error banner.
    void onConfirmDocType(opt);
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
      <div className="bg-white rounded-3xl max-w-lg w-full shadow-2xl shadow-blue-200/40 ring-1 ring-slate-200 overflow-hidden">
        {/* Header — text-only. Title + body left-aligns with "Which is it?"
            below at the same container padding (px-7). pt-10 gives the title
            generous breathing room from the modal's top edge per Andrew's
            polish pass. */}
        <div className="px-7 pt-10 pb-6">
          <h2 className="text-lg font-bold text-slate-900 leading-snug">
            Let&rsquo;s double check your document type
          </h2>
          <p className="text-sm text-slate-600 mt-2 leading-relaxed">
            You said this is{" "}
            <strong className="font-semibold text-slate-900">
              {indefiniteArticle(userPickPretty)} {userPickPretty.toLowerCase()}
            </strong>
            , but it looks more like{" "}
            <strong className="font-semibold text-slate-900">
              {indefiniteArticle(classifierPickPretty)} {classifierPickPretty.toLowerCase()}
            </strong>
            <span className="text-slate-500">
              {" "}({Math.round(confirmationData.classifier_confidence * 100)}% confident)
            </span>
            .
          </p>
        </div>

        {/* Choice prompt + option cards. px-7 matches header for left-edge
            alignment between "Let's double check..." and "Which is it?". */}
        <div className="px-7 pb-6 bg-gradient-to-b from-white to-slate-50/60">
          <h3 className="text-base font-semibold text-slate-900 mb-3">
            Which is it?
          </h3>
          <div className="grid grid-cols-1 gap-3 auto-rows-fr">
            {confirmationData.options.map((opt) => {
              const isClassifierPick = opt === confirmationData.classifier_pick;
              const label = pickerLabel(opt);
              const description = pickerDescription(opt);
              return (
                <button
                  key={opt}
                  disabled={clicked}
                  onClick={() => handleConfirm(opt)}
                  className={`group relative w-full text-left p-4 bg-white rounded-2xl ring-1 transition-all disabled:cursor-not-allowed ${
                    clicked
                      ? "ring-slate-200 opacity-60"
                      : isClassifierPick
                        ? "ring-blue-200 hover:ring-2 hover:ring-blue-500 hover:shadow-md hover:shadow-blue-100"
                        : "ring-slate-200 hover:ring-2 hover:ring-slate-400 hover:shadow-md"
                  }`}
                >
                  {/* items-start so the "Our guess" badge aligns with the TOP of
                      the title row instead of vertical-centering against the
                      whole flex line. */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="font-semibold text-slate-900">{label}</div>
                    {isClassifierPick && (
                      <span className="shrink-0 text-[10px] font-bold tracking-wider uppercase text-white bg-gradient-to-r from-blue-500 to-indigo-600 px-2.5 py-1 rounded-full shadow-sm shadow-blue-200">
                        Our guess
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-slate-600 mt-1.5 leading-relaxed">
                    {description}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Cancel footer */}
        <div className="px-7 py-4 border-t border-slate-100 bg-white flex justify-end items-center">
          <button
            disabled={clicked}
            onClick={handleCancel}
            className="text-sm font-medium text-slate-500 hover:text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Cancel — upload a different file
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
