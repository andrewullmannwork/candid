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
  /** S301 — carried in from another of the user's same-insurer disputes. */
  appealsCarriedFromPriorDispute?: boolean;
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

/**
 * The unconfirmed-appeals-address prompt. PURE + exported so the exact strings
 * are asserted in a fixture (S300 lesson: when a surface and its copy share a
 * vocabulary, assert the strings, don't trust them).
 *
 * TWO provenances, two prompts (S301):
 *   carried — the user typed this address on ANOTHER of their bills for this same
 *             insurer. Say so. A bare "Last verified «date»" would read as a
 *             Candid verification of something the user supplied themselves, and
 *             the date shown would belong to a different bill.
 *   catalog — shared, admin-mediated data. Keeps its existing Block C2.2 prompt.
 *
 * Carried copy Andrew-approved S301, verbatim.
 */
export function appealsConfirmCopy(input: {
  carriedFromPriorDispute: boolean;
  insurerName: string;
  lastVerified: string;
}): { prompt: string; confirmLabel: string; changeLabel: string } {
  if (input.carriedFromPriorDispute) {
    return {
      prompt: `You used this address for ${input.insurerName} on an earlier bill. Still correct?`,
      confirmLabel: "Use this",
      changeLabel: "Change",
    };
  }
  return {
    prompt: `Last verified ${input.lastVerified}. Is this the right appeals address?`,
    confirmLabel: "Looks right",
    changeLabel: "Not correct",
  };
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

  const hasAddress = !!insurer.appealsAddress;
  const btnPrimary =
    "inline-flex items-center justify-center rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow disabled:cursor-wait disabled:opacity-70";
  const btnSecondary =
    "inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-px hover:bg-slate-50 hover:shadow";

  // Confirmed (just now via "Looks right") OR already-confirmed from the server
  // → an editable "Verified · Edit address" row. Block C2.2 (note 1): the
  // post-confirm state is NO LONGER a dead end — Edit is always available.
  if (state === "confirmed" || !needsConfirmation) {
    const when = state === "confirmed" ? "just now" : lastVerified;
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
          <CheckGlyph />
          Verified {when}.
        </span>
        {onProposeCorrection ? (
          <button
            type="button"
            onClick={() => onProposeCorrection(insurer.id)}
            className={btnSecondary}
          >
            Edit address
          </button>
        ) : null}
      </div>
    );
  }

  // No address on file yet. S265 (Z1 refine d) — the recipient card is display-only:
  // Zone-1's "Insurer appeals address" row owns adding a missing address, so without a
  // propose handler there's nothing to show here (avoids a duplicate "Add address" prompt).
  if (!hasAddress) {
    if (!onProposeCorrection) return null;
    return (
      <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2.5 text-xs text-amber-900">
        <p className="mb-2 font-medium">
          We don&apos;t have {insurer.name}&apos;s appeals address yet.
        </p>
        <button
          type="button"
          onClick={() => onProposeCorrection(insurer.id)}
          className={btnPrimary}
        >
          Add address
        </button>
      </div>
    );
  }

  // Address present but unconfirmed — prompt + labels come from the pure copy
  // resolver so the exact strings are fixture-asserted rather than trusted.
  const copy = appealsConfirmCopy({
    carriedFromPriorDispute: insurer.appealsCarriedFromPriorDispute === true,
    insurerName: insurer.name,
    lastVerified,
  });
  return (
    <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2.5 text-xs text-amber-900">
      <p className="mb-2 font-medium">{copy.prompt}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={state === "confirming"}
          className={btnPrimary}
        >
          {state === "confirming" ? "Confirming…" : copy.confirmLabel}
        </button>
        {onProposeCorrection ? (
          <button
            type="button"
            onClick={() => onProposeCorrection(insurer.id)}
            className={btnSecondary}
          >
            {copy.changeLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function CheckGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
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
