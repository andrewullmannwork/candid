/**
 * InsurerAddressCorrectionModal — S74 Pillar 1
 *
 * Wires the previously-orphaned "Not correct" button on DisputeRecipientCard's
 * VerifyStrip. POSTs to /api/disputes/insurer-appeals/confirm with
 * `action='proposed_correction'`; admin reviews the proposed values via the
 * existing insurer_appeals_proposed_changes queue (Phase 6.2).
 *
 * Why a modal vs inline form: the appeals address has 5 fields plus phone.
 * Cramming them into the recipient card would crowd the "Addressed to" column.
 * Modal preserves the card's clean two-column layout.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { validateUsAddress } from "@/lib/address/validate-us-address";

interface CurrentValues {
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  phone: string;
}

interface Props {
  open: boolean;
  insurerName: string;
  insurerId: string;
  initialValues: CurrentValues;
  onClose: () => void;
  onSubmitted?: () => void | Promise<void>;
  /** Caller supplies the bearer-token fetch helper so we don't duplicate auth wiring. */
  getAuthToken: () => Promise<string | null>;
}

export function InsurerAddressCorrectionModal({
  open,
  insurerName,
  insurerId,
  initialValues,
  onClose,
  onSubmitted,
  getAuthToken,
}: Props) {
  const [values, setValues] = useState<CurrentValues>(initialValues);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Reset state every time the modal re-opens so a stale failed submit doesn't
  // bleed into a fresh open. Focus the first field on open for keyboard users.
  useEffect(() => {
    if (open) {
      setValues(initialValues);
      setError(null);
      setSubmitting(false);
      // Focus async so the modal animates in cleanly before the focus lands.
      setTimeout(() => firstFieldRef.current?.focus(), 50);
    }
  }, [open, initialValues]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Block C2 — validate through the shared helper so the insurer + provider
    // address surfaces enforce the same rules (required line1/city/state/ZIP +
    // state-set + ZIP format). Surfaces the first error in the existing banner.
    const addrErrors = validateUsAddress({
      addressLine1: values.addressLine1,
      addressLine2: values.addressLine2,
      city: values.city,
      state: values.state,
      postalCode: values.postalCode,
    });
    const firstError = Object.values(addrErrors)[0];
    if (firstError) {
      setError(firstError);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const token = await getAuthToken();
      if (!token) throw new Error("Sign-in expired. Please reload and try again.");
      const res = await fetch("/api/disputes/insurer-appeals/confirm", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          insurerId,
          action: "proposed_correction",
          proposedValues: {
            addressLine1: values.addressLine1.trim(),
            addressLine2: values.addressLine2.trim() || undefined,
            city: values.city.trim() || undefined,
            state: values.state.trim() || undefined,
            postalCode: values.postalCode.trim() || undefined,
            phone: values.phone.trim() || undefined,
          },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Failed to submit (${res.status})`);
      }
      await onSubmitted?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="insurer-correction-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="insurer-correction-title" className="text-lg font-semibold text-slate-900">
              Suggest a corrected appeals address
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Tell us the correct mailing address for {insurerName} appeals. We&apos;ll
              review the change and update the address other members see if it
              checks out.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
            aria-label="Close"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-3">
          <Field label="Address line 1" required>
            <input
              ref={firstFieldRef}
              type="text"
              value={values.addressLine1}
              onChange={(e) => setValues({ ...values, addressLine1: e.target.value })}
              required
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </Field>
          <Field label="Address line 2 (optional)">
            <input
              type="text"
              value={values.addressLine2}
              onChange={(e) => setValues({ ...values, addressLine2: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="City">
              <input
                type="text"
                value={values.city}
                onChange={(e) => setValues({ ...values, city: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="State">
                <input
                  type="text"
                  value={values.state}
                  onChange={(e) => setValues({ ...values, state: e.target.value.toUpperCase() })}
                  maxLength={2}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </Field>
              <Field label="ZIP">
                <input
                  type="text"
                  value={values.postalCode}
                  onChange={(e) => setValues({ ...values, postalCode: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </Field>
            </div>
          </div>
          <Field label="Phone (optional)">
            <input
              type="tel"
              value={values.phone}
              onChange={(e) => setValues({ ...values, phone: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </Field>

          {error ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </div>
          ) : null}

          <div className="mt-2 flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60"
            >
              {submitting ? "Submitting…" : "Submit correction"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
        {required ? <span className="ml-1 text-rose-600">*</span> : null}
      </span>
      {children}
    </label>
  );
}
