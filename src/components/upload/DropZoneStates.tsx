"use client";

/**
 * Drop-zone inner-render fns — the visual content that lives inside the
 * /upload drop-zone container per state. Outer container (border / hover
 * glow / drag-drop handlers) lives in upload/page.tsx.
 *
 * States ported from design upload.jsx (B2-UP.1):
 *   - DropIdle       — pre-pick CTA + "browse files" + 20MB hint + tips toggle
 *   - DropHover      — drag-over visual confirmation
 *   - DropUploading  — bytes-in-flight progress bar + filename
 *
 * Active parsing (priority 10) renders <StackLoaderV3> directly — not via
 * these inner-render fns. Terminal exception priorities (1-4 + 8-9) render
 * ParseTerminalView inside the drop-zone container; heavy interactive
 * exceptions (5-7) render OUTSIDE/below per D-§1.B.1-E.
 */

export interface DropIdleProps {
  kind: "bill" | "plan";
  onPickFile: () => void;
  tipsOpen: boolean;
  onToggleTips: () => void;
}

export function DropIdle({ kind, onPickFile, tipsOpen, onToggleTips }: DropIdleProps) {
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-100 text-blue-600">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
        </svg>
      </div>
      <div className="text-base font-semibold text-slate-900">
        Drop your {kind === "bill" ? "bill or EOB" : "plan document"} here
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-slate-500">
        <span>
          or{" "}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPickFile();
            }}
            className="font-semibold text-blue-600 underline-offset-2 hover:underline"
          >
            browse files
          </button>
        </span>
        <span className="inline-block h-1 w-1 rounded-full bg-slate-300" />
        <span>PDF, JPG, or PNG · up to 20 MB</span>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleTips();
        }}
        className="mt-1 inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
      >
        {tipsOpen ? "Hide tips" : "Where do I find this?"}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transform: tipsOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }}
        >
          <path d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
}

export function DropHover() {
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-200 text-blue-700">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 16V4m0 0l-4 4m4-4l4 4" />
        </svg>
      </div>
      <div className="text-base font-semibold text-blue-700">Drop to upload</div>
      <div className="text-xs text-slate-500">We&rsquo;ll start parsing immediately.</div>
    </div>
  );
}

export interface DropUploadingProps {
  fileName: string;
  uploadProgress: number;
  onCancel?: () => void;
}

export function DropUploading({ fileName, uploadProgress, onCancel }: DropUploadingProps) {
  return (
    <div className="relative flex flex-col items-center gap-3 py-2 text-center">
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="absolute right-0 top-0 inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          aria-label="Cancel upload"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 6l12 12M6 18L18 6" />
          </svg>
        </button>
      )}
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-100 text-blue-600">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="animate-spin">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
          <path d="M22 12a10 10 0 00-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </div>
      <div className="text-base font-semibold text-slate-900">
        Uploading {fileName || "your document"}…
      </div>
      <div className="h-1.5 w-48 overflow-hidden rounded-full bg-slate-200">
        <div
          className="h-full rounded-full bg-blue-600 transition-all duration-300"
          style={{ width: `${Math.max(0, Math.min(100, uploadProgress))}%` }}
        />
      </div>
      <div className="text-xs text-slate-500">{uploadProgress}% complete</div>
    </div>
  );
}

export interface DropDoneProps {
  kind: "bill" | "plan";
  fileName: string;
  onUploadAnother: () => void;
  onViewResults: () => void;
}

/**
 * DropDone — happy-path completion visual rendered inside the drop-zone
 * container at ProcessingFlow priorities 8-9 (complete_bill / complete_plan)
 * when no premium prompt + no supplement prompt is needed. Complex completion
 * paths (needsPremium / showSupplementPrompt) fall back to ParseTerminalView
 * inside the drop-zone container so S102 Q1 + supplement flows stay intact.
 *
 * Findings-count derivation (design's "Candid found 3 issues" / "32 benefits")
 * deferred to a fast-follow — needs a backend hop to claim_line_items /
 * plan_covered_services counts.
 */
export function DropDone({ kind, fileName, onUploadAnother, onViewResults }: DropDoneProps) {
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <div className="text-base font-semibold text-slate-900">
        Done! Your {kind === "bill" ? "bill is" : "plan is"} ready.
      </div>
      {fileName && (
        <div className="text-xs text-slate-500">
          <span className="font-medium text-slate-700">{fileName}</span>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={onUploadAnother}
          className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
        >
          Upload another
        </button>
        <button
          type="button"
          onClick={onViewResults}
          className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
        >
          {kind === "bill" ? "View claim" : "View benefits"} →
        </button>
      </div>
    </div>
  );
}
