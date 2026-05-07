"use client";

/**
 * S70 — Multi-document uploader for /compare.
 *
 * Drag-drop OR file-picker for up to 3 PDFs (SBC or plan_document). Caller
 * supplies the maximum (default 3) and the active count (already chosen).
 * Component is presentational + selection-only — caller owns the upload pipeline
 * (which fans out to /api/documents/upload, polls /api/documents/status, and
 * routes to PlayfulParsingScreen).
 *
 * Per Q-S70-2 LOCK + user direction: this is the entry surface BEFORE parsing
 * starts. PlayfulParsingScreen takes over once the user clicks "Compare these".
 */

import { useCallback, useRef, useState } from "react";

interface MultiDocUploaderProps {
  /** Files already selected — controlled by parent. */
  selected: File[];
  /** Called when files are added or removed. Parent commits to state. */
  onChange: (files: File[]) => void;
  /** Max docs allowed (per Q-S70-1 LOCK A; default 3). */
  max?: number;
  /** Disable while parent is uploading. */
  disabled?: boolean;
  /** Submit-button label override. */
  submitLabel?: string;
  /** Called when the user clicks the submit/compare button. */
  onSubmit: () => void;
}

const ACCEPTED_TYPES = ["application/pdf"];
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB — matches /api/documents/upload cap.

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function MultiDocUploader({
  selected,
  onChange,
  max = 3,
  disabled = false,
  submitLabel,
  onSubmit,
}: MultiDocUploaderProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const acceptFiles = useCallback(
    (incoming: FileList | File[]) => {
      setError(null);
      const arr = Array.from(incoming);
      const next: File[] = [...selected];
      for (const f of arr) {
        if (next.length >= max) break;
        if (!ACCEPTED_TYPES.includes(f.type)) {
          setError(`"${f.name}" isn't a PDF — only PDFs are supported here.`);
          continue;
        }
        if (f.size > MAX_FILE_BYTES) {
          setError(`"${f.name}" is over 25MB. Try the SBC summary version instead.`);
          continue;
        }
        // Skip dupes by name+size (cheap heuristic; not perfect but good enough).
        if (next.some((existing) => existing.name === f.name && existing.size === f.size)) {
          continue;
        }
        next.push(f);
      }
      onChange(next);
    },
    [max, onChange, selected],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      if (disabled) return;
      acceptFiles(e.dataTransfer.files);
    },
    [acceptFiles, disabled],
  );

  const handleRemove = useCallback(
    (idx: number) => {
      onChange(selected.filter((_, i) => i !== idx));
    },
    [onChange, selected],
  );

  const slotsLeft = max - selected.length;
  const canSubmit = !disabled && selected.length >= 2;
  const planLetter = (i: number) => String.fromCharCode(65 + i); // 0→A, 1→B, 2→C

  return (
    <div className="space-y-4">
      {/* ── Selected files list ─────────────────────────────────────── */}
      {selected.length > 0 && (
        <div className="space-y-2">
          {selected.map((file, idx) => (
            <div
              key={`${file.name}-${file.size}-${idx}`}
              className="flex items-center gap-3 p-3 rounded-xl bg-white ring-1 ring-slate-200"
            >
              <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                <span className="text-xs font-bold text-blue-700">Plan {planLetter(idx)}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-900 truncate">{file.name}</p>
                <p className="text-xs text-slate-500">{formatBytes(file.size)} · PDF</p>
              </div>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => handleRemove(idx)}
                  className="text-slate-400 hover:text-rose-600 transition-colors p-1"
                  aria-label={`Remove ${file.name}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Drag-drop zone (always visible until max reached) ───────── */}
      {slotsLeft > 0 && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          onClick={() => !disabled && fileInputRef.current?.click()}
          className={`relative cursor-pointer rounded-2xl border-2 border-dashed transition-all p-8 text-center ${
            isDragOver
              ? "border-blue-400 bg-blue-50"
              : "border-slate-200 hover:border-blue-300 hover:bg-slate-50"
          } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            multiple
            className="hidden"
            disabled={disabled}
            onChange={(e) => {
              if (e.target.files) acceptFiles(e.target.files);
              // Reset so picking the same file twice fires onChange.
              e.target.value = "";
            }}
          />
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-blue-100 mb-3">
            <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </div>
          <p className="text-sm font-medium text-slate-900">
            {selected.length === 0
              ? "Drop your plan PDFs here, or click to browse"
              : `Add ${slotsLeft} more plan${slotsLeft !== 1 ? "s" : ""} (optional)`}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            SBC or plan-summary PDFs · up to 25MB each · {max - slotsLeft} of {max} added
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2">
          <p className="text-xs text-rose-700">{error}</p>
        </div>
      )}

      {/* ── Submit ──────────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        className={`w-full py-3 rounded-xl text-sm font-semibold transition-all ${
          canSubmit
            ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-200 hover:shadow-lg hover:shadow-blue-300"
            : "bg-slate-100 text-slate-400 cursor-not-allowed"
        }`}
      >
        {submitLabel ??
          (selected.length < 2
            ? `Add at least 2 plans to compare (${selected.length}/2)`
            : `Compare ${selected.length} plan${selected.length === 1 ? "" : "s"}`)}
      </button>
    </div>
  );
}
