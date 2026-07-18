/**
 * ProviderAddressModal — dispute-letters v2 Zone-1.
 *
 * Modal shell around the existing ProviderAddressForm so the provider mailing address
 * can be added / edited from the Zone-1 "What we need from you" panel (map §6), mirroring
 * the insurer appeals-address modal — two clearly-distinct address surfaces, both reachable
 * from Zone-1. Prefills from the current provider contact so a saved address is editable.
 *
 * Surface 4 (clarity redesign): the hand-rolled overlay is replaced by the
 * central ModalShell — same form, same API, plus Esc-to-close, focus trap,
 * scroll lock, and focus restore for free (advances the migration documented
 * in components/modal/index.tsx).
 */
"use client";

import { ModalShell } from "@/components/modal";
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
  return (
    <ModalShell
      open={open}
      onClose={onClose}
      size="lg"
      title="Provider mailing address"
      subtitle="Where we'll send a provider-directed letter."
      ariaLabel="Provider mailing address"
    >
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
    </ModalShell>
  );
}
