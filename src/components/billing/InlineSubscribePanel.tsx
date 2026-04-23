"use client";

/**
 * Inline Subscribe Panel — standalone subscribe form (no modal shell).
 *
 * Rendered in-place where a LockedOverlay CTA card would otherwise sit, so
 * the user sees the card collection in the same visual slot as the upgrade
 * prompt instead of a floating modal. Used by /disputes + /claim via
 * LockedOverlay's `subscribePanel` prop.
 *
 * For surfaces without LockedOverlay (e.g. /billing), use EmbeddedSubscribeFlow
 * which wraps this logic in a modal shell.
 */

import { useEffect, useRef, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import type { StripeElementsOptions } from "@stripe/stripe-js";
import { getStripeBrowser } from "@/lib/stripe/browser";
import { useAuth } from "@/lib/auth/auth-context";
import type { TriggerSurface } from "@/components/billing/EmbeddedSubscribeFlow";

export interface InlineSubscribePanelProps {
  triggerSurface: TriggerSurface;
  contextRibbon?: { headline: string; subline: string };
  /** Secondary line under "Upgrade to Candid Pro". Defaults to the three-
   *  feature summary; override per surface to keep the pitch focused. */
  subtitle?: string;
  onSuccess: () => void | Promise<void>;
  onCancel: () => void;
}

export function InlineSubscribePanel({
  triggerSurface,
  contextRibbon,
  subtitle = "Unlimited dispute letters · lawyer directory · community pricing.",
  onSuccess,
  onCancel,
}: InlineSubscribePanelProps) {
  const { user } = useAuth();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  // Keep onSuccess in a ref so re-renders (e.g. from waitFor polling) don't
  // re-fire the create-subscription effect. Without this, every parent
  // render creates a new inline arrow function for onSuccess, which would
  // bust the useEffect deps and spawn a fresh Stripe subscription per render.
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);

  // React Strict Mode mounts every effect twice in dev. Without this guard
  // each mount fires POST /api/stripe/create-subscription → two Stripe
  // customers + subscriptions per click. Ref persists across the intentional
  // double-mount and blocks the second call.
  const didInitRef = useRef(false);

  useEffect(() => {
    if (!user) return;
    if (didInitRef.current) return;
    didInitRef.current = true;

    // No cancellation flag: the didInitRef guard already ensures this runs
    // exactly once per mount. A Strict Mode simulated cleanup would flip a
    // `cancelled` flag mid-fetch and prevent setClientSecret from ever being
    // called, leaving the panel stuck on the spinner. If the component
    // truly unmounts while the fetch is pending, setState on an unmounted
    // component is a dev-only warning with no real impact.
    (async () => {
      try {
        const token = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/stripe/create-subscription", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ triggerSurface }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (data.error === "already_subscribed") {
            onSuccessRef.current();
            return;
          }
          setInitError(data.error || "Failed to start subscription");
          return;
        }
        setClientSecret(data.clientSecret);
      } catch (err) {
        setInitError(err instanceof Error ? err.message : "Failed to start subscription");
      }
    })();
  }, [user, triggerSurface]);

  const options: StripeElementsOptions | undefined = clientSecret
    ? { clientSecret, appearance: { theme: "stripe" } }
    : undefined;

  return (
    <div className="w-full max-w-lg mx-auto text-left">
      {contextRibbon && (
        <div className="mb-4 rounded-xl border border-blue-100 bg-gradient-to-br from-blue-50 to-indigo-50 p-4">
          <p className="text-sm font-semibold text-blue-900">{contextRibbon.headline}</p>
          <p className="mt-0.5 text-xs text-blue-700">{contextRibbon.subline}</p>
        </div>
      )}

      <h2 className="text-lg font-bold text-gray-900">Upgrade to Candid Pro</h2>
      <p className="mt-1 text-xs text-gray-500">{subtitle}</p>

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
        <div className="mt-6 flex items-center justify-center py-8">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        </div>
      )}
    </div>
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
    // webhook-driven subscription tier flip before dismissing the form.
    setFinalizing(true);
    setSubmitting(false);
    try {
      await onSuccess();
    } finally {
      setFinalizing(false);
    }
  }

  const buttonLabel = finalizing
    ? "Activating subscription…"
    : submitting
      ? "Processing payment…"
      : "Subscribe to Pro";

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
          {buttonLabel}
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
