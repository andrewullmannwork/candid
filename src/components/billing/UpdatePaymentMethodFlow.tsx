"use client";

/**
 * Update Payment Method Flow — embedded Stripe Elements modal for swapping
 * the card on file without touching the subscription.
 *
 * Used by /billing "Update card" button and Free-tier "Add a card". Backed by
 * Stripe's SetupIntent (no charge), with confirmSetup() on submit.
 */

import { useEffect, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import type { StripeElementsOptions } from "@stripe/stripe-js";
import { getStripeBrowser } from "@/lib/stripe/browser";
import { useAuth } from "@/lib/auth/auth-context";

export interface UpdatePaymentMethodFlowProps {
  isOpen: boolean;
  onSuccess: () => void;
  onCancel: () => void;
}

export function UpdatePaymentMethodFlow(props: UpdatePaymentMethodFlowProps) {
  if (!props.isOpen) return null;
  return <UpdatePaymentMethodModal {...props} />;
}

function UpdatePaymentMethodModal({
  onSuccess,
  onCancel,
}: Omit<UpdatePaymentMethodFlowProps, "isOpen">) {
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

  return (
    <ModalShell onClose={onCancel}>
      <h2 className="text-lg font-bold text-gray-900">Update payment method</h2>
      <p className="mt-1 text-xs text-gray-500">
        Card is saved to Stripe and used for your next renewal.
      </p>

      {initError && (
        <p className="mt-4 rounded-lg border border-red-100 bg-red-50 p-3 text-xs text-red-700">
          {initError}
        </p>
      )}

      {clientSecret && options && (
        <Elements stripe={getStripeBrowser()} options={options}>
          <SetupForm onSuccess={onSuccess} onCancel={onCancel} />
        </Elements>
      )}

      {!clientSecret && !initError && (
        <div className="mt-4 flex items-center justify-center py-8">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        </div>
      )}
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
          className="flex-1 rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
        >
          {submitting ? "Saving…" : "Save card"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-4 py-2.5 text-sm text-gray-500 hover:text-gray-700 disabled:text-gray-300"
        >
          Cancel
        </button>
      </div>
      <p className="text-center text-[11px] text-gray-400">
        Secured by Stripe · card details never stored on Candid servers.
      </p>
    </form>
  );
}

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
      <div className="relative w-full max-w-md rounded-2xl bg-white pt-10 pb-6 px-6 shadow-xl">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 rounded-full bg-white/80 p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        {children}
      </div>
    </div>
  );
}
