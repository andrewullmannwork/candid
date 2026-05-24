"use client";

/**
 * FindTipsPanel — expandable "Where do I find this?" panel under the drop
 * zone for /upload (B2-UP.1 port). Open state owned by parent.
 *
 * Tips content sourced from doc-type-vocabulary PICKER_OPTIONS so the same
 * tips array drives both the legacy panel and this design-aligned panel.
 */

export interface FindTipsPanelProps {
  kind: "bill" | "plan";
  open: boolean;
  onClose: () => void;
  tips: readonly string[];
}

export function FindTipsPanel({ kind, open, onClose, tips }: FindTipsPanelProps) {
  if (!open) return null;
  const heading = kind === "bill" ? "HOW TO FIND YOUR BILL" : "HOW TO FIND YOUR PLAN DOCUMENT";
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
      <ol className="space-y-2">
        {tips.map((tip, i) => (
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
    </div>
  );
}
