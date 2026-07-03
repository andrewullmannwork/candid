/**
 * CollectorModal — dispute-letters v2 Zone-3 (S266).
 *
 * Captures the collector details a debt-validation (C1) letter needs when the
 * user reports "Sent to collections." Name is required (the letter is addressed
 * to the collector); address + original creditor + first-contact date are
 * optional. First-contact date anchors the FDCPA §1692g 30-day window (the
 * cease-collection lever renders only when the letter is within it). On submit
 * the caller POSTs /api/disputes/[disputeId]/escalate with targetLetterType
 * "debt_validation".
 */
"use client";

import { useState } from "react";

export interface CollectorSubmit {
  collector: { name: string; address: string | null; originalCreditor: string | null };
  collectorFirstContactDate: string | null;
}

interface Props {
  open: boolean;
  submitting?: boolean;
  onCancel: () => void;
  onSubmit: (input: CollectorSubmit) => void;
}

export function CollectorModal({ open, submitting, onCancel, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [originalCreditor, setOriginalCreditor] = useState("");
  const [firstContact, setFirstContact] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  function handleSubmit() {
    if (!name.trim()) {
      setError("The collection agency's name is required.");
      return;
    }
    setError(null);
    onSubmit({
      collector: {
        name: name.trim(),
        address: address.trim() || null,
        originalCreditor: originalCreditor.trim() || null,
      },
      collectorFirstContactDate: firstContact || null,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="collector-modal-title"
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="border-b border-slate-100 px-6 py-4">
          <h2 id="collector-modal-title" className="text-base font-semibold text-slate-900">
            Who contacted you about collections?
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            We&apos;ll draft a debt-validation letter to the collection agency requesting proof the
            debt is valid — and, if you&apos;re within 30 days of their first contact, asking them to
            pause collection until they respond.
          </p>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div>
            <label htmlFor="collector-name" className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Collection agency name <span className="text-red-500">*</span>
            </label>
            <input
              id="collector-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. ABC Recovery Services"
              className="mt-1 block w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label htmlFor="collector-address" className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Mailing address <span className="font-normal normal-case text-slate-400">(optional)</span>
            </label>
            <textarea
              id="collector-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              rows={2}
              placeholder="Street, City, State ZIP"
              className="mt-1 block w-full resize-y rounded-md border border-slate-200 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="collector-creditor" className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Original creditor <span className="font-normal normal-case text-slate-400">(optional)</span>
              </label>
              <input
                id="collector-creditor"
                type="text"
                value={originalCreditor}
                onChange={(e) => setOriginalCreditor(e.target.value)}
                placeholder="e.g. the hospital"
                className="mt-1 block w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="collector-first-contact" className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                First contacted you <span className="font-normal normal-case text-slate-400">(optional)</span>
              </label>
              <input
                id="collector-first-contact"
                type="date"
                value={firstContact}
                onChange={(e) => setFirstContact(e.target.value)}
                className="mt-1 block w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-6 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-md border border-slate-200 bg-white px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {submitting ? "Creating…" : "Create debt-validation letter"}
          </button>
        </div>
      </div>
    </div>
  );
}
