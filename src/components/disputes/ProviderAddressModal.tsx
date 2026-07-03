/**
 * ProviderAddressModal — dispute-letters v2 Zone-1.
 *
 * Modal shell around the existing ProviderAddressForm so the provider mailing address
 * can be added / edited from the Zone-1 "What we need from you" panel (map §6), mirroring
 * the insurer appeals-address modal — two clearly-distinct address surfaces, both reachable
 * from Zone-1. Prefills from the current provider contact so a saved address is editable.
 */
"use client";

import { ProviderAddressForm } from "./ProviderAddressForm";

interface Props {
  open: boolean;
  disputeId: string;
  initialName: string | null;
  initialAddressFields: {
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
  } | null;
  initialPhone: string | null;
  initialNpi: string | null;
  getAuthToken: () => Promise<string | null>;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

export function ProviderAddressModal({
  open,
  disputeId,
  initialName,
  initialAddressFields,
  initialPhone,
  initialNpi,
  getAuthToken,
  onClose,
  onSaved,
}: Props) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Provider mailing address"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Provider mailing address</h3>
            <p className="mt-0.5 text-[13px] text-gray-500">Where we&apos;ll send a provider-directed letter.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <ProviderAddressForm
          disputeId={disputeId}
          initialName={initialName}
          initialAddress={null}
          initialAddressFields={initialAddressFields}
          initialPhone={initialPhone}
          initialNpi={initialNpi}
          getAuthToken={getAuthToken}
          onSaved={async () => {
            await onSaved();
            onClose();
          }}
        />
      </div>
    </div>
  );
}
