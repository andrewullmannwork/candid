"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Inline edit primitive for empty-field "Add" affordances (S121 B2.1).
 *
 * Per Q2 critical analysis at S121 — favored over modal for short text fields
 * (member_id, etc.) because (a) lighter cognitive load, (b) faster perceived
 * response (no portal/backdrop), (c) sets a consistent pattern across all
 * dashboard KV pairs.
 *
 * Behavior:
 * - Default state: emptyLabel + [Add] button
 * - Click [Add]: input replaces label; auto-focused; Save button + optional
 *   secondaryAction link (e.g., "Re-scan card") render alongside
 * - Enter or Save click: invokes onSave(value); resets to default on success
 * - Esc or blur-with-empty: silently revert to default state
 * - Esc with content: discard (no confirm gate; member-id-class fields aren't
 *   destructive enough to warrant one)
 */
interface InlineEditFieldProps {
  emptyLabel?: string;
  placeholder: string;
  onSave: (value: string) => Promise<void>;
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  maxLength?: number;
}

export function InlineEditField({
  emptyLabel = "Not set",
  placeholder,
  onSave,
  secondaryAction,
  maxLength = 64,
}: InlineEditFieldProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const handleSave = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setValue("");
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setValue("");
      setEditing(false);
      setError(null);
    }
  };

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-400">{emptyLabel}</span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs font-semibold text-blue-600 hover:text-blue-700"
        >
          Add
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={saving}
          className="flex-1 min-w-0 px-2.5 py-1.5 text-sm border border-blue-300 rounded-lg bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !value.trim()}
          className="text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {secondaryAction && (
        <button
          type="button"
          onClick={secondaryAction.onClick}
          className="self-start text-xs text-gray-500 hover:text-blue-700 underline-offset-2 hover:underline"
        >
          Or {secondaryAction.label.toLowerCase()}
        </button>
      )}
      {error && <p className="text-xs text-red-600 font-medium">{error}</p>}
    </div>
  );
}
