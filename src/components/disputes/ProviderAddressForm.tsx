/**
 * ProviderAddressForm — S74 Pillar 3 (Block C2: structured + validated)
 *
 * Inline form rendered inside the EvidenceGaps card when the linked claim is
 * missing (or is editing) the provider's mailing address. Without an address the
 * printed dispute letter has no recipient. POSTs structured fields to
 * /api/claims/[claimId]/provider-contact (S310 — claim-scoped, where the data
 * lives; the old dispute-scoped route only hopped dispute → claim and is
 * deleted); the parent refetches the dispute so the recipient block + letter
 * body update in place.
 *
 * Block C2: replaced the freeform address textarea with structured fields
 * (line1/line2/city/state/ZIP) validated through the shared `validateUsAddress`
 * helper — the same validator the insurer correction modal uses, so the two
 * address surfaces never drift. A garbage/partial address weakens a mailed letter
 * (and the case), so address fields are required + format-checked before submit.
 * Name + phone + NPI stay optional polish. Stays INLINE (the EvidenceGaps card is
 * built to expand in place); the rail scroll fix makes it reachable.
 */
"use client";

import { useState } from "react";
import {
  validateUsAddress,
  composeUsAddress,
  type UsAddressErrors,
} from "@/lib/address/validate-us-address";

interface Props {
  claimId: string;
  initialName: string | null;
  initialAddress: string | null;
  initialPhone: string | null;
  initialNpi: string | null;
  /** Block C2 — structured seed when the address was already captured structured. */
  initialAddressFields?: {
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
  } | null;
  /** Bearer-token fetch helper so we don't duplicate auth wiring. */
  getAuthToken: () => Promise<string | null>;
  /** Parent refetches the dispute on success so recipient + letter body update. */
  onSaved?: () => void | Promise<void>;
}

export function ProviderAddressForm({
  claimId,
  initialName,
  initialPhone,
  initialNpi,
  initialAddressFields,
  getAuthToken,
  onSaved,
}: Props) {
  const [name, setName] = useState(initialName ?? "");
  const [addressLine1, setAddressLine1] = useState(
    initialAddressFields?.addressLine1 ?? "",
  );
  const [addressLine2, setAddressLine2] = useState(
    initialAddressFields?.addressLine2 ?? "",
  );
  const [city, setCity] = useState(initialAddressFields?.city ?? "");
  const [state, setState] = useState(initialAddressFields?.state ?? "");
  const [postalCode, setPostalCode] = useState(
    initialAddressFields?.postalCode ?? "",
  );
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [npi, setNpi] = useState(initialNpi ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<UsAddressErrors>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const addressFields = { addressLine1, addressLine2, city, state, postalCode };
    const errs = validateUsAddress(addressFields);
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      setStatus("error");
      setError("Check the highlighted address fields.");
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    setStatus("idle");
    setError(null);
    try {
      const token = await getAuthToken();
      if (!token) throw new Error("Sign-in expired. Please reload and try again.");
      const res = await fetch(`/api/claims/${claimId}/provider-contact`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: name.trim() || undefined,
          // Compose the display string the letter renders + send structured parts
          // so the backend persists both (structured wins on re-edit).
          address: composeUsAddress(addressFields),
          addressFields: {
            addressLine1: addressLine1.trim(),
            addressLine2: addressLine2.trim() || undefined,
            city: city.trim(),
            state: state.trim().toUpperCase(),
            postalCode: postalCode.trim(),
          },
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

  const inputClass = (hasError: boolean) =>
    `w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-1 ${
      hasError
        ? "border-rose-300 focus:border-rose-500 focus:ring-rose-500"
        : "border-slate-300 focus:border-blue-500 focus:ring-blue-500"
    }`;

  return (
    <form onSubmit={handleSubmit} className="mt-3 space-y-3 rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <FormField label="Provider name" optional>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={initialName || "e.g., Stanford Hospital Billing"}
          className={inputClass(false)}
        />
      </FormField>

      <FormField label="Street address" error={fieldErrors.addressLine1}>
        <input
          type="text"
          value={addressLine1}
          onChange={(e) => setAddressLine1(e.target.value)}
          placeholder="e.g., 300 Pasteur Drive"
          aria-invalid={!!fieldErrors.addressLine1}
          className={inputClass(!!fieldErrors.addressLine1)}
        />
      </FormField>

      <FormField label="Suite / unit" optional>
        <input
          type="text"
          value={addressLine2}
          onChange={(e) => setAddressLine2(e.target.value)}
          placeholder="e.g., Ste 200 — Billing Dept"
          className={inputClass(false)}
        />
      </FormField>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_5rem_7rem]">
        <FormField label="City" error={fieldErrors.city}>
          <input
            type="text"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="e.g., Palo Alto"
            aria-invalid={!!fieldErrors.city}
            className={inputClass(!!fieldErrors.city)}
          />
        </FormField>
        <FormField label="State" error={fieldErrors.state}>
          <input
            type="text"
            value={state}
            onChange={(e) => setState(e.target.value.toUpperCase())}
            placeholder="CA"
            maxLength={2}
            aria-invalid={!!fieldErrors.state}
            className={inputClass(!!fieldErrors.state)}
          />
        </FormField>
        <FormField label="ZIP" error={fieldErrors.postalCode}>
          <input
            type="text"
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value)}
            placeholder="94304"
            inputMode="numeric"
            aria-invalid={!!fieldErrors.postalCode}
            className={inputClass(!!fieldErrors.postalCode)}
          />
        </FormField>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Phone" optional>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="e.g., (650) 555-0123"
            className={inputClass(false)}
          />
        </FormField>
        <FormField label="NPI" optional hint="10 digits">
          <input
            type="text"
            value={npi}
            onChange={(e) => setNpi(e.target.value)}
            placeholder="e.g., 1234567890"
            maxLength={10}
            inputMode="numeric"
            className={inputClass(false)}
          />
        </FormField>
      </div>

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
          {submitting ? "Saving…" : "Save provider address"}
        </button>
      </div>
    </form>
  );
}

function FormField({
  label,
  optional,
  hint,
  error,
  children,
}: {
  label: string;
  optional?: boolean;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
        {optional ? <span className="ml-1 normal-case text-slate-400">(optional)</span> : null}
        {hint ? <span className="ml-1 normal-case text-slate-400">· {hint}</span> : null}
      </span>
      {children}
      {error ? <span className="mt-1 block text-xs text-rose-600">{error}</span> : null}
    </label>
  );
}
