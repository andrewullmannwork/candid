/**
 * DisputeRecipientCard — Phase 2 + Phase 6
 *
 * "Addressed to" + "Requested action" two-column card. When the recipient
 * is an insurer (not a provider), renders the full appeals address + phone.
 * Includes the Phase 6.2 verify strip when the address needs confirmation.
 */
import { useState } from "react";

interface InsurerShape {
  id: string;
  name: string;
  appealsAddress: {
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postalCode: string;
  } | null;
  appealsPhone: string | null;
  appealsLastConfirmedAt: string | null;
  needsConfirmation: boolean;
}

interface Props {
  recipient: {
    name: string;
    role: string;
    address?: string;
    phone?: string;
  };
  insurer: InsurerShape | null;
  requestedAction: string;
  letterTypeLabel: string;
  planYear: number | null;
  referenceId: string;
  /** Called when user clicks "Looks right" on the verify strip. */
  onConfirmAddress?: (insurerId: string) => Promise<void> | void;
  /** Called when user clicks "Not correct" / "Edit address". Opens the correction flow owned by the parent. */
  onProposeCorrection?: (insurerId: string) => void;
  /**
   * Block C2 — when true, the insurer address strip is ALWAYS shown (even once
   * the address is already confirmed) so the user can edit it; without it the
   * strip only appears when the address needs confirmation. The parent passes
   * this only for v3 + insurer-recipient letters; provider addresses are edited
   * via the EvidenceGaps "Add provider address" form, not here.
   */
  allowAddressEdit?: boolean;
}

export function DisputeRecipientCard({
  recipient,
  insurer,
  requestedAction,
  letterTypeLabel,
  planYear,
  referenceId,
  onConfirmAddress,
  onProposeCorrection,
  allowAddressEdit = false,
}: Props) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="grid gap-6 p-6 md:grid-cols-2 md:gap-8">
        <AddressedToBlock
          recipient={recipient}
          insurer={insurer}
          onConfirmAddress={onConfirmAddress}
          onProposeCorrection={onProposeCorrection}
          allowAddressEdit={allowAddressEdit}
        />
        <RequestedActionBlock requestedAction={requestedAction} />
      </div>
      <div className="flex flex-wrap gap-2 border-t border-slate-100 bg-slate-50/50 px-6 py-3 text-[11px] font-medium uppercase tracking-wide text-slate-500">
        <Chip label={`Letter type: ${letterTypeLabel}`} />
        {planYear ? <Chip label={`Plan year: ${planYear}`} /> : null}
        <Chip label={`Ref: ${referenceId.slice(0, 8).toUpperCase()}`} />
      </div>
    </div>
  );
}

function AddressedToBlock({
  recipient,
  insurer,
  onConfirmAddress,
  onProposeCorrection,
  allowAddressEdit = false,
}: {
  recipient: Props["recipient"];
  insurer: InsurerShape | null;
  onConfirmAddress?: Props["onConfirmAddress"];
  onProposeCorrection?: Props["onProposeCorrection"];
  allowAddressEdit?: boolean;
}) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Addressed to
      </div>
      <div className="mt-2">
        <div className="text-base font-semibold text-slate-900">{recipient.name}</div>
        <div className="text-sm text-slate-600">{recipient.role}</div>
        {recipient.address ? (
          <div className="mt-3 whitespace-pre-line text-sm leading-relaxed text-slate-700">
            {recipient.address}
          </div>
        ) : null}
        {recipient.phone ? (
          <div className="mt-1 text-sm text-slate-600">📞 {recipient.phone}</div>
        ) : null}
      </div>
      {insurer && onConfirmAddress && (insurer.needsConfirmation || allowAddressEdit) ? (
        <VerifyStrip
          insurer={insurer}
          needsConfirmation={insurer.needsConfirmation}
          onConfirmAddress={onConfirmAddress}
          onProposeCorrection={onProposeCorrection}
        />
      ) : null}
    </div>
  );
}

function VerifyStrip({
  insurer,
  needsConfirmation,
  onConfirmAddress,
  onProposeCorrection,
}: {
  insurer: InsurerShape;
  needsConfirmation: boolean;
  onConfirmAddress: NonNullable<Props["onConfirmAddress"]>;
  onProposeCorrection?: Props["onProposeCorrection"];
}) {
  const [state, setState] = useState<"idle" | "confirming" | "confirmed">("idle");

  const handleConfirm = async () => {
    setState("confirming");
    try {
      await onConfirmAddress(insurer.id);
      setState("confirmed");
    } catch {
      setState("idle");
    }
  };

  const lastVerified = insurer.appealsLastConfirmedAt
    ? new Date(insurer.appealsLastConfirmedAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "never";

  if (state === "confirmed") {
    return (
      <p className="mt-3 text-xs italic text-emerald-700">
        Thanks — we marked this address as confirmed.
      </p>
    );
  }

  // Already-confirmed address (Block C2 edit affordance) — neutral row with a
  // single "Edit address" link that opens the same correction flow. No amber
  // "needs verification" affect, since nothing is wrong with the address.
  if (!needsConfirmation) {
    return (
      <div className="mt-3 text-xs text-slate-500">
        <span>Verified {lastVerified}.</span>{" "}
        {onProposeCorrection ? (
          <button
            type="button"
            onClick={() => onProposeCorrection(insurer.id)}
            className="font-medium text-blue-600 underline-offset-2 hover:text-blue-700 hover:underline"
          >
            Edit address
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2 text-xs text-amber-900">
      <span className="font-medium">Last verified {lastVerified}.</span>{" "}
      <button
        type="button"
        onClick={handleConfirm}
        disabled={state === "confirming"}
        className="underline underline-offset-2 hover:text-amber-950 disabled:opacity-50"
      >
        {state === "confirming" ? "Confirming…" : "Looks right"}
      </button>
      {onProposeCorrection ? (
        <>
          {" · "}
          <button
            type="button"
            onClick={() => onProposeCorrection(insurer.id)}
            className="underline underline-offset-2 hover:text-amber-950"
          >
            Not correct
          </button>
        </>
      ) : null}
    </div>
  );
}

function RequestedActionBlock({ requestedAction }: { requestedAction: string }) {
  const { headline, detail } = splitRequestedAction(requestedAction);
  return (
    <div className="md:border-l md:border-slate-100 md:pl-8">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Requested action
      </div>
      <div className="mt-2">
        <div className="text-base font-semibold text-slate-900">{headline}</div>
        {detail ? (
          <div className="text-sm text-slate-600">{detail}</div>
        ) : null}
      </div>
    </div>
  );
}

// Splits the single-line requestedAction into a short headline + detail. Keeps
// the left (Addressed to) and right (Requested action) columns visually
// parallel: short bold line, muted subtext below.
function splitRequestedAction(text: string): { headline: string; detail: string | null } {
  const trimmed = text.trim().replace(/\.$/, "");
  // Break on the first " and " / " — " / " - " / " : " — otherwise fall back
  // to chunking long sentences at ~32 chars on a word boundary.
  const splitMatch = trimmed.match(/^(.+?)(?:\s+(?:and|—|-|:)\s+)(.+)$/i);
  if (splitMatch) {
    return {
      headline: capitalize(splitMatch[1].trim()) + ".",
      detail: capitalize(splitMatch[2].trim()) + ".",
    };
  }
  if (trimmed.length <= 36) {
    return { headline: capitalize(trimmed) + ".", detail: null };
  }
  const pivot = trimmed.slice(0, 36).lastIndexOf(" ");
  if (pivot <= 0) return { headline: capitalize(trimmed) + ".", detail: null };
  return {
    headline: capitalize(trimmed.slice(0, pivot).trim()) + ".",
    detail: capitalize(trimmed.slice(pivot).trim()) + ".",
  };
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Chip({ label }: { label: string }) {
  return (
    <span className="rounded-full bg-white px-2.5 py-1 shadow-sm ring-1 ring-slate-200">
      {label}
    </span>
  );
}
