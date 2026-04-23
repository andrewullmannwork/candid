"use client";

/**
 * Embedded Subscribe Flow — in-app Stripe Elements modal for Candid Pro.
 *
 * Triggered inline from any paywalled surface (/claim, /case, /care) via
 * LockedOverlay. Collects CC inside the blurred preview; no redirect to
 * Stripe Checkout. Success flips the user's tier to Pro and calls onSuccess
 * so the parent can unlock the feature immediately.
 *
 * Reusable primitive — this component does NOT know about disputes, care, or
 * case. Callers pass a contextRibbon + triggerSurface to brand the modal per
 * surface.
 */

import { useEffect, useRef, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import type { StripeElementsOptions } from "@stripe/stripe-js";
import { getStripeBrowser } from "@/lib/stripe/browser";
import { useAuth } from "@/lib/auth/auth-context";

export type TriggerSurface = "dispute" | "case" | "care";

export interface EmbeddedSubscribeFlowProps {
  isOpen: boolean;
  triggerSurface: TriggerSurface;
  contextRibbon?: { headline: string; subline: string };
  onSuccess: () => void | Promise<void>;
  onCancel: () => void;
}

export function EmbeddedSubscribeFlow(props: EmbeddedSubscribeFlowProps) {
  if (!props.isOpen) return null;
  return <EmbeddedSubscribeModal {...props} />;
}

function EmbeddedSubscribeModal({
  triggerSurface,
  contextRibbon,
  onSuccess,
  onCancel,
}: Omit<EmbeddedSubscribeFlowProps, "isOpen">) {
  const { user } = useAuth();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);

  // Guard against React Strict Mode double-mount (dev-only) — without this,
  // each effect invocation fires POST /api/stripe/create-subscription and
  // spawns a second Stripe customer + subscription.
  const didInitRef = useRef(false);

  useEffect(() => {
    if (!user) return;
    if (didInitRef.current) return;
    didInitRef.current = true;
    let cancelled = false;
    async function init() {
      try {
        const token = await user!.firebaseUser.getIdToken();
        const res = await fetch("/api/stripe/create-subscription", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ triggerSurface }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          if (data.error === "already_subscribed") {
            // Edge case: user opened modal while webhook was activating a
            // prior subscription. Close quietly + trigger a refresh.
            onSuccessRef.current();
            return;
          }
          setInitError(data.error || "Failed to start subscription");
          return;
        }
        setClientSecret(data.clientSecret);
      } catch (err) {
        if (!cancelled) {
          setInitError(err instanceof Error ? err.message : "Failed to start subscription");
        }
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [user, triggerSurface]);

  const options: StripeElementsOptions | undefined = clientSecret
    ? { clientSecret, appearance: { theme: "stripe" } }
    : undefined;

  return (
    <ModalShell onClose={onCancel}>
      {contextRibbon && (
        <div className="mb-4 rounded-xl border border-blue-100 bg-gradient-to-br from-blue-50 to-indigo-50 p-4">
          <p className="text-sm font-semibold text-blue-900">{contextRibbon.headline}</p>
          <p className="mt-0.5 text-xs text-blue-700">{contextRibbon.subline}</p>
        </div>
      )}

      <h2 className="text-lg font-bold text-gray-900">Upgrade to Candid Pro</h2>
      <p className="mt-1 text-xs text-gray-500">
        Unlimited dispute letters · lawyer directory · community pricing.
      </p>

      {initError && (
        <p className="mt-4 rounded-lg border border-red-100 bg-red-50 p-3 text-xs text-red-700">
          {initError}
        </p>
      )}

      {clientSecret && options && (
        <Elements stripe={getStripeBrowser()} options={options}>
          <SubscribeForm onSuccess={onSuccess} onCancel={onCancel} />
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

function SubscribeForm({
  onSuccess,
  onCancel,
}: {
  onSuccess: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const { error: stripeError } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        // confirmPayment returns here on success — no navigation.
        return_url: `${window.location.origin}${window.location.pathname}`,
      },
      redirect: "if_required",
    });

    if (stripeError) {
      setError(stripeError.message ?? "Payment failed");
      setSubmitting(false);
      return;
    }

    // Payment confirmed client-side. Hand off to parent which polls the
    // webhook-driven subscription tier flip before dismissing the modal.
    setFinalizing(true);
    setSubmitting(false);
    try {
      await onSuccess();
    } finally {
      setFinalizing(false);
    }
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
          disabled={!stripe || submitting || finalizing}
          className="flex-1 rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
        >
          {finalizing ? "Activating subscription…" : submitting ? "Processing payment…" : "Subscribe to Pro"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting || finalizing}
          className="px-4 py-2.5 text-sm text-gray-500 hover:text-gray-700 disabled:text-gray-300"
        >
          Cancel
        </button>
      </div>
      <p className="text-center text-[11px] text-gray-400">
        Secured by Stripe · cancel anytime · card details never stored on Candid servers.
      </p>
    </form>
  );
}

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
      <div className="relative w-full max-w-md rounded-2xl bg-white pt-10 pb-6 px-6 shadow-xl">
        {/* Close button pinned in the top padding band so it never collides
            with the first content block (e.g. blue context ribbon). */}
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
