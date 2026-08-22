"use client";

/**
 * FindTipsPanel — expandable "Where do I find this?" panel under the drop
 * zone for /upload (B2-UP.1 port). Open state owned by parent.
 *
 * Two render modes, driven by the picker option's shape:
 *   - findGuide present (plan_document) → two labeled PATHS (how to GET it:
 *     ask HR / check the portal) + a "what to ask for / look for" explanation
 *     (SBC / EOC — what the document actually is).
 *   - tips only (bill) → the legacy numbered list.
 */

import type { PickerOption, PlanFindGuide } from "@/lib/classifier/doc-type-vocabulary";

export interface FindTipsPanelProps {
  kind: "bill" | "plan";
  open: boolean;
  onClose: () => void;
  option: PickerOption;
}

/** The panel's heading — exported so a collapsed header row (S322 onboarding
 *  doc step) can show the same title without a second copy of the string. */
export function findTipsHeading(kind: "bill" | "plan"): string {
  return kind === "bill" ? "HOW TO FIND YOUR BILL" : "HOW TO FIND YOUR PLAN DOCUMENT";
}

export function FindTipsPanel({ kind, open, onClose, option }: FindTipsPanelProps) {
  if (!open) return null;
  const heading = findTipsHeading(kind);
  return (
    <div className="mt-3 rounded-2xl border border-slate-100 bg-slate-50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{heading}</div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-500 transition-colors hover:text-slate-700"
        >
          Close ×
        </button>
      </div>
      {"findGuide" in option ? (
        <FindGuide guide={option.findGuide} />
      ) : (
        <ol className="space-y-2">
          {option.tips.map((tip, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-100 text-[10px] font-bold text-blue-700">
                {i + 1}
              </span>
              <span
                className="text-xs leading-relaxed text-slate-600"
                dangerouslySetInnerHTML={{ __html: tip.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>") }}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * Structured "two paths + explanation" layout for plan documents.
 * Paths reuse the numbered-badge visual (Path 1 / Path 2); the explanation
 * sits in its own white card so "what am I looking for?" reads as distinct
 * from "how do I get it?".
 */
function FindGuide({ guide }: { guide: PlanFindGuide }) {
  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        {guide.paths.map((path, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-100 text-[10px] font-bold text-blue-700">
              {i + 1}
            </span>
            <span className="text-xs leading-relaxed text-slate-600">
              <span className="font-semibold text-slate-700">{path.label}</span>
              {" — "}
              {path.body}
            </span>
          </li>
        ))}
      </ol>
      <div className="rounded-xl border border-slate-100 bg-white p-3">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
          {guide.lookForHeading}
        </div>
        <ul className="space-y-1.5">
          {guide.lookFor.map((item, i) => (
            <li key={i} className="text-xs leading-relaxed text-slate-600">
              <span className="font-semibold text-slate-700">{item.term}</span>
              {" — "}
              {item.desc}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
