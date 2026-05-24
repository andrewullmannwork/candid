"use client";

import { useRef } from "react";

interface Props {
  value: File | null;
  onChange: (file: File | null) => void;
  maxBytes?: number;
  acceptHint?: string;
}

const DEFAULT_MAX = 25 * 1024 * 1024;
const ACCEPT_ATTR = "application/pdf,image/jpeg,image/jpg,image/png";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AttachmentDropzone({
  value,
  onChange,
  maxBytes = DEFAULT_MAX,
  acceptHint = "PDF, JPG, PNG · up to 25 MB",
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFile(file: File | null) {
    if (!file) return;
    if (file.size > maxBytes) {
      alert(`File exceeds ${formatSize(maxBytes)} limit`);
      return;
    }
    onChange(file);
  }

  if (value) {
    return (
      <div className="flex items-center gap-3 p-3 border border-gray-200 rounded-xl bg-gray-50">
        <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center flex-shrink-0">
          <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.2 8.8L9.5 14.5a2 2 0 002.8 2.8L18 11.6a4 4 0 00-5.7-5.7L6.6 11.6a6 6 0 008.5 8.5l6-6"
            />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-gray-900 truncate">{value.name}</div>
          <div className="text-sm text-gray-500">{formatSize(value.size)}</div>
        </div>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="w-8 h-8 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 flex items-center justify-center"
          aria-label="Remove attachment"
        >
          <svg width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <label
      className="flex flex-col items-center justify-center gap-2 p-6 border-2 border-dashed border-gray-300 rounded-xl bg-gray-50 hover:border-blue-400 hover:bg-blue-50/30 cursor-pointer transition-colors"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        handleFile(e.dataTransfer.files?.[0] ?? null);
      }}
    >
      <div className="w-10 h-10 rounded-lg bg-white border border-gray-200 flex items-center justify-center text-gray-500">
        <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
          />
        </svg>
      </div>
      <div className="text-sm text-gray-700">
        <span className="text-blue-600 font-medium">Click to upload</span> or drop a file here
      </div>
      <div className="text-xs text-gray-500">{acceptHint}</div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
      />
    </label>
  );
}
