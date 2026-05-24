"use client";

/**
 * Update Payment Method Flow — embedded Stripe Elements modal for swapping
 * the card on file without touching the subscription.
 *
 * Backed by Stripe's SetupIntent (no charge), with confirmSetup() on submit.
 * Card number, expires, and CVC live inside Stripe-hosted iframes via
 * <PaymentElement /> (PCI-safe — never raw inputs in our DOM). Stripe Link
 * affordance is rendered by Stripe automatically when Link is enabled in
 * Stripe Dashboard settings.
 *
 * NON-NEGOTIABLE per Candid_Context "Card data lives in Stripe only" hard
 * rule: this flow uses <PaymentElement /> — never raw card-number inputs.
 *
 * Design chrome (Subplan §B2.2 + s116-batch-4-billing + Add Card Modal):
 *   - ModalShell from B1.1 primitives (eyebrow + title + dismiss)
 *   - Current-card preview block at the top (UPDATE flow only)
 *   - "Card" method tab chrome above the Stripe Elements form
 *   - Airgetlam Labs LLC charge-authorization disclaimer below form
 *   - Stripe secure footer with lock icon + copy
 *   - Save card (primary) + Cancel (ghost) actions
 */

import { useEffect, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import type { StripeElementsOptions } from "@stripe/stripe-js";
import { getStripeBrowser } from "@/lib/stripe/browser";
import { useAuth } from "@/lib/auth/auth-context";
import { ModalShell } from "@/components/modal";

export interface UpdatePaymentMethodFlowProps {
  isOpen: boolean;
  onSuccess: () => void;
  onCancel: () => void;
  /** Optional current-card preview metadata — when provided, renders a
   *  "CURRENT" preview block at the top of the form. */
  currentCard?: {
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
    cardholderName: string | null;
  };
}

function titleCaseBrand(brand: string | null): string {
  if (!brand) return "Card";
  return brand.charAt(0).toUpperCase() + brand.slice(1).toLowerCase();
}

function formatExpiry(month: number | null, year: number | null): string {
  if (!month || !year) return "—/—";
  return `${String(month).padStart(2, "0")}/${String(year).slice(-2)}`;
}

function CardMethodTab() {
  return (
    <div className="flex items-center gap-3 border-b border-gray-100 pb-3">
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-50 text-blue-600">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" />
          <path d="M2.5 10h19" />
        </svg>
      </span>
      <span className="text-sm font-semibold text-blue-600">Card</span>
      <span className="ml-auto rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] text-blue-700">
        Selected
      </span>
    </div>
  );
}

function CurrentCardPreview({
  brand,
  last4,
  expMonth,
  expYear,
  cardholderName,
}: NonNullable<UpdatePaymentMethodFlowProps["currentCard"]>) {
  if (!last4) return null;
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
      <div className="flex items-center gap-3">
        <span className="flex h-7 w-10 items-center justify-center rounded bg-slate-900 text-[10px] font-bold uppercase tracking-wider text-white">
          {titleCaseBrand(brand)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm text-gray-900">
            •••• •••• •••• {last4}
          </div>
          <div className="text-[11px] text-gray-500">
            Expires {formatExpiry(expMonth, expYear)}
            {cardholderName ? ` · ${cardholderName}` : ""}
          </div>
        </div>
        <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gray-700">
          Current
        </span>
      </div>
      <div className="mt-2 text-[12px] text-gray-500">
        Replace with new details below.
      </div>
    </div>
  );
}

function StripeSecureFooter() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5 text-[12px] leading-snug text-gray-600">
      <svg
        className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-500"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
      <span>
        Card details are entered directly into{" "}
        <strong className="font-semibold text-gray-800">Stripe&apos;s</strong>{" "}
        secure form — they never touch Candid servers.
      </span>
    </div>
  );
}

function AirgetlamDisclaimer() {
  return (
    <p className="text-[12px] leading-relaxed text-gray-500">
      By providing your card information, you allow{" "}
      <span className="font-medium text-gray-700">Airgetlam Labs LLC</span> to
      charge your card for future payments in accordance with their terms.
    </p>
  );
}

export function UpdatePaymentMethodFlow(props: UpdatePaymentMethodFlowProps) {
  if (!props.isOpen) return null;
  return <UpdatePaymentMethodModal {...props} />;
}

function UpdatePaymentMethodModal({
  isOpen,
  onSuccess,
  onCancel,
  currentCard,
}: UpdatePaymentMethodFlowProps) {
  const { user } = useAuth();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    async function init() {
      try {
        const token = await user!.firebaseUser.getIdToken();
        const res = await fetch("/api/stripe/create-setup-intent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setInitError(data.error || "Failed to start card update");
          return;
        }
        setClientSecret(data.clientSecret);
      } catch (err) {
        if (!cancelled) {
          setInitError(err instanceof Error ? err.message : "Failed to start card update");
        }
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const options: StripeElementsOptions | undefined = clientSecret
    ? { clientSecret, appearance: { theme: "stripe" } }
    : undefined;

  const hasCurrentCard = !!currentCard?.last4;

  return (
    <ModalShell
      open={isOpen}
      onClose={onCancel}
      tone="default"
      size="md"
      eyebrow={hasCurrentCard ? "Replace your card on file" : "Add card on file"}
      title={hasCurrentCard ? "Update card" : "Add card"}
    >
      <div className="space-y-4">
        {hasCurrentCard && currentCard && <CurrentCardPreview {...currentCard} />}

        <div className="rounded-2xl border border-gray-200 p-4">
          <CardMethodTab />

          {initError && (
            <p className="mt-3 rounded-lg border border-red-100 bg-red-50 p-3 text-xs text-red-700">
              {initError}
            </p>
          )}

          {clientSecret && options && (
            <Elements stripe={getStripeBrowser()} options={options}>
              <SetupForm onSuccess={onSuccess} onCancel={onCancel} />
            </Elements>
          )}

          {!clientSecret && !initError && (
            <div className="flex items-center justify-center py-8">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
            </div>
          )}
        </div>

        <AirgetlamDisclaimer />
        <StripeSecureFooter />
      </div>
    </ModalShell>
  );
}

function SetupForm({ onSuccess, onCancel }: { onSuccess: () => void; onCancel: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const { error: stripeError } = await stripe.confirmSetup({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}${window.location.pathname}`,
      },
      redirect: "if_required",
    });

    if (stripeError) {
      setError(stripeError.message ?? "Card update failed");
      setSubmitting(false);
      return;
    }

    setSubmitting(false);
    onSuccess();
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-3">
      <PaymentElement />
      {error && (
        <p className="rounded-lg border border-red-100 bg-red-50 p-2 text-xs text-red-700">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={!stripe || submitting}
          className="flex-1 rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
        >
          {submitting ? "Saving…" : "Save card"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-4 py-2.5 text-sm font-medium text-gray-500 hover:text-gray-700 disabled:text-gray-300"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
