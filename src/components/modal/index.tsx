'use client';

/**
 * Candid Modal primitives — central modal system per Phase 2 Subplan §B1.1.
 *
 * USAGE
 *   - <ModalShell>   : generic shell with header/body/footer slots + tones + sizes + sheet variant
 *   - <ConfirmModal> : quick yes/no with optional destructive styling
 *   - <SuccessModal> : completion state with green check icon + optional reference code
 *
 * Every modal:
 *   - Renders into document.body via createPortal
 *   - Esc-to-close + click-outside-to-close (when dismissable)
 *   - Focus trap inside the dialog + restore focus to trigger on close
 *   - Body scroll lock while open
 *   - role="dialog" + aria-modal="true" + aria-label/aria-labelledby
 *
 * PER-MODAL MAPPING TABLE (Subplan §1.A.3 Resolution — migrations land in later batches):
 *
 *   Current (ad-hoc)                         →  Future helper
 *   ─────────────────────────────────────────────────────────────────────
 *   DocTypeConfirmationModal                 →  ModalShell + custom pill-row footer (D-S112-B)
 *   OutcomeReportingModal                    →  ModalShell
 *   PlanSearchModal (S111 CF-60 — UNTOUCHED) →  ModalShell — NON-NEGOTIABLE preserve verbatim
 *   InsurerAddressCorrectionModal            →  ModalShell
 *   DownloadWarningModal                     →  ConfirmModal
 *   CategoryCorrectionModal                  →  ModalShell
 *   CancelSubscriptionDialog                 →  ConfirmModal destructive
 *   EmbeddedSubscribeFlow                    →  ModalShell (preserve Stripe Elements mount — NON-NEGOTIABLE)
 *   UpdatePaymentMethodFlow                  →  ModalShell (preserve Stripe Elements mount — NON-NEGOTIABLE)
 *
 *   Migrations land in later batches (B2.x+). B1.1 introduces the primitives only.
 */

import { type ReactNode } from 'react';
import { ModalShell, type ModalShellProps, type ModalTone, type ModalSize } from './modal-shell';
import { cn } from '@/lib/utils/cn';

export { ModalShell };
export type { ModalShellProps, ModalTone, ModalSize };

// ── ConfirmModal ──────────────────────────────────────────────────────────

export interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm?: () => void;
  tone?: ModalTone;
  title?: string;
  subtitle?: ReactNode;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  tone = 'default',
  title,
  subtitle,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
}: ConfirmModalProps) {
  return (
    <ModalShell
      open={open}
      onClose={onClose}
      tone={tone}
      size="sm"
      title={title}
      subtitle={subtitle}
      footer={
        <>
          <button
            onClick={onClose}
            className="px-4 py-2.5 text-[14px] font-semibold text-gray-700 hover:bg-gray-100 rounded-xl transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm || onClose}
            className={cn(
              'px-4 py-2.5 text-[14px] font-semibold text-white rounded-xl transition-colors',
              destructive
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-blue-600 hover:bg-blue-700',
            )}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {body && (
        <p className="text-[15px] text-gray-700 leading-relaxed">{body}</p>
      )}
    </ModalShell>
  );
}

// ── SuccessModal ──────────────────────────────────────────────────────────

export interface SuccessModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: ReactNode;
  body?: ReactNode;
  primaryLabel?: string;
  onPrimary?: () => void;
  reference?: string;
}

export function SuccessModal({
  open,
  onClose,
  title,
  subtitle,
  body,
  primaryLabel = 'Done',
  onPrimary,
  reference,
}: SuccessModalProps) {
  return (
    <ModalShell
      open={open}
      onClose={onClose}
      tone="success"
      size="sm"
      icon={
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 13l4 4L19 7" />
        </svg>
      }
      title={title}
      subtitle={subtitle}
      footer={
        <button
          onClick={onPrimary || onClose}
          className="flex-1 inline-flex items-center justify-center px-4 py-2.5 text-[14px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors"
        >
          {primaryLabel}
        </button>
      }
    >
      {body && (
        <p className="text-[15px] text-gray-700 leading-relaxed">{body}</p>
      )}
      {reference && (
        <div className="mt-3 rounded-xl bg-gray-50 px-3 py-2.5 flex items-center justify-between gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-gray-500">
            Reference
          </span>
          <code className="text-[13px] font-mono text-gray-700">{reference}</code>
        </div>
      )}
    </ModalShell>
  );
}
