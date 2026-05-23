'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils/cn';

export type ModalTone = 'default' | 'success' | 'warn' | 'danger' | 'info';
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  tone?: ModalTone;
  size?: ModalSize;
  sheet?: boolean;
  icon?: ReactNode;
  eyebrow?: string;
  title?: string;
  subtitle?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  dismissable?: boolean;
  showClose?: boolean;
  className?: string;
  ariaLabel?: string;
}

const TONE_ICON: Record<ModalTone, string> = {
  default: 'bg-gray-100 text-gray-700',
  success: 'bg-green-100 text-green-700',
  warn:    'bg-amber-100 text-amber-700',
  danger:  'bg-red-100 text-red-700',
  info:    'bg-blue-100 text-blue-700',
};

const SIZE_PX: Record<ModalSize, number> = {
  sm: 400,
  md: 520,
  lg: 640,
  xl: 820,
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ModalShell({
  open,
  onClose,
  tone = 'default',
  size = 'md',
  sheet = false,
  icon,
  eyebrow,
  title,
  subtitle,
  children,
  footer,
  dismissable = true,
  showClose = true,
  className,
  ariaLabel,
}: ModalShellProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const triggerElementRef = useRef<HTMLElement | null>(null);

  // Esc-to-close
  useEffect(() => {
    if (!open || !dismissable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, dismissable, onClose]);

  // Body scroll lock
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Focus management: capture trigger, focus first focusable, trap Tab, restore on close
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    triggerElementRef.current = active instanceof HTMLElement ? active : null;

    const dialog = dialogRef.current;
    if (dialog) {
      const focusables = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        dialog.focus();
      }
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !dialog) return;
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const trigger = triggerElementRef.current;
      if (trigger && document.contains(trigger)) {
        trigger.focus();
      }
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const widthPx = SIZE_PX[size];

  const content = (
    <div
      className={cn(
        'fixed inset-0 z-50 flex',
        sheet ? 'items-end justify-center' : 'items-center justify-center p-4',
        'bg-black/50 backdrop-blur-sm',
        'animate-fade-in',
      )}
      onClick={() => {
        if (dismissable) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={title && !ariaLabel ? 'modal-title' : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'bg-white shadow-2xl flex flex-col max-h-[90vh]',
          sheet ? 'w-full rounded-t-3xl' : 'w-full rounded-2xl',
          className,
        )}
        style={sheet ? undefined : { maxWidth: widthPx }}
      >
        {icon && (
          <div
            className={cn(
              'mx-6 mt-6 inline-flex items-center justify-center w-11 h-11 rounded-xl flex-shrink-0',
              TONE_ICON[tone],
            )}
            aria-hidden="true"
          >
            {icon}
          </div>
        )}

        {(eyebrow || title || subtitle || (showClose && dismissable)) && (
          <div className="flex items-start justify-between gap-4 px-6 pt-6">
            <div className="flex-1 min-w-0">
              {eyebrow && (
                <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-gray-500 mb-1">
                  {eyebrow}
                </div>
              )}
              {title && (
                <h2
                  id="modal-title"
                  className="text-lg font-bold text-gray-900 tracking-tight"
                >
                  {title}
                </h2>
              )}
              {subtitle && (
                <p className="mt-1 text-[14px] text-gray-500 leading-relaxed">
                  {subtitle}
                </p>
              )}
            </div>
            {showClose && dismissable && (
              <button
                onClick={onClose}
                aria-label="Close"
                className="flex-shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            )}
          </div>
        )}

        {children && (
          <div className="px-6 pt-4 pb-2 flex-1 overflow-y-auto text-[15px] text-gray-700 leading-relaxed">
            {children}
          </div>
        )}

        {footer && (
          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-100">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
