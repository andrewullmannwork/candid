/**
 * ProviderAddressForm — S74 Pillar 3
 *
 * Inline form rendered inside the EvidenceGaps card when the linked claim is
 * missing the provider's mailing address. Without an address the printed dispute
 * letter has no recipient. POSTs to /api/disputes/[disputeId]/provider-contact;
 * the parent refetches the dispute so the recipient block + letter body update
 * in place.
 *
 * Address is the only required field — the user often can find that on the bill
 * itself even when the bill parser couldn't extract it (multi-column layouts,
 * tiny font on second page, etc.). Name + phone + NPI are optional polish.
 */
"use client";

import { useState } from "react";

interface Props {
  disputeId: string;
  initialName: string | null;
  initialAddress: string | null;
  initialPhone: string | null;
  initialNpi: string | null;
  /** Bearer-token fetch helper so we don't duplicate auth wiring. */
  getAuthToken: () => Promise<string | null>;
  /** Parent refetches the dispute on success so recipient + letter body update. */
  onSaved?: () => void | Promise<void>;
}

export function ProviderAddressForm({
  disputeId,
  initialName,
  initialAddress,
  initialPhone,
  initialNpi,
  getAuthToken,
  onSaved,
}: Props) {
  const [name, setName] = useState(initialName ?? "");
  const [address, setAddress] = useState(initialAddress ?? "");
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [npi, setNpi] = useState(initialNpi ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address.trim() && !name.trim() && !phone.trim() && !npi.trim()) {
      setError("Add at least one field — usually the billing address from the bill.");
      setStatus("error");
      return;
    }
    setSubmitting(true);
    setStatus("idle");
    setError(null);
    try {
      const token = await getAuthToken();
      if (!token) throw new Error("Sign-in expired. Please reload and try again.");
      const res = await fetch(`/api/disputes/${disputeId}/provider-contact`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: name.trim() || undefined,
          address: address.trim() || undefined,
          phone: phone.trim() || undefined,
          npi: npi.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Failed to save (${res.status})`);
      }
      setStatus("saved");
      await onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
      setStatus("error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mt-3 space-y-3 rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Provider name <span className="text-slate-400 normal-case">(optional override)</span>
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={initialName || "e.g., Stanford Hospital Billing"}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Phone <span className="text-slate-400 normal-case">(optional)</span>
          </span>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="e.g., (650) 555-0123"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Billing address
        </span>
        <textarea
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          rows={3}
          placeholder={"e.g.,\n300 Pasteur Drive\nPalo Alto, CA 94304"}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          NPI <span className="text-slate-400 normal-case">(optional · 10 digits)</span>
        </span>
        <input
          type="text"
          value={npi}
          onChange={(e) => setNpi(e.target.value)}
          placeholder="e.g., 1234567890"
          maxLength={10}
          inputMode="numeric"
          className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </label>

      {status === "error" && error ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </div>
      ) : null}
      {status === "saved" ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          Saved. The letter will use the updated address.
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow disabled:cursor-wait disabled:opacity-70"
        >
          {submitting ? "Saving…" : "Save provider contact"}
        </button>
      </div>
    </form>
  );
}
