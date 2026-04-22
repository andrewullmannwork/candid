"use client";

/**
 * /billing — Subscription management surface.
 *
 * Writes back every state the embedded flow set elsewhere: plan, card,
 * invoice history, cancel/resume. All mutations go through our API routes
 * (no Stripe Portal redirect). See Candid_Context "Subscription & Billing"
 * for hard rules.
 */

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { useSubscription } from "@/lib/subscription/use-subscription";
import { useSubscribeTrigger } from "@/components/billing/SubscribeTrigger";
import { UpdatePaymentMethodFlow } from "@/components/billing/UpdatePaymentMethodFlow";
import { CancelSubscriptionDialog } from "@/components/billing/CancelSubscriptionDialog";
import { InvoiceList } from "@/components/billing/InvoiceList";

interface CardSummary {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function titleCaseBrand(brand: string | null): string {
  if (!brand) return "Card";
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

export default function BillingPage() {
  const { user } = useAuth();
  const { tier, status, loading, isPro, cancelAtPeriodEnd, periodEnd, refresh, waitFor } =
    useSubscription();
  const { trigger: openSubscribe, render: renderSubscribe, redirecting } = useSubscribeTrigger();

  const [card, setCard] = useState<CardSummary | null>(null);
  const [cardLoading, setCardLoading] = useState(true);
  const [updateCardOpen, setUpdateCardOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [resumeSubmitting, setResumeSubmitting] = useState(false);

  useEffect(() => {
    if (!user) return;
    async function load() {
      const token = await user!.firebaseUser.getIdToken();
      const res = await fetch("/api/subscription/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setCard({
          brand: data.cardBrand,
          last4: data.cardLast4,
          expMonth: data.cardExpMonth,
          expYear: data.cardExpYear,
        });
      } else {
        setCard(null);
      }
      setCardLoading(false);
    }
    load();
  }, [user]);

  async function handleResume() {
    if (!user) return;
    setResumeSubmitting(true);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/stripe/resume-subscription", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) await refresh();
    } catch (err) {
      console.error("Resume failed:", err);
    }
    setResumeSubmitting(false);
  }

  async function reloadCard() {
    if (!user) return;
    const token = await user.firebaseUser.getIdToken();
    const res = await fetch("/api/subscription/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      setCard(null);
      return;
    }
    const data = await res.json();
    setCard({
      brand: data.cardBrand,
      last4: data.cardLast4,
      expMonth: data.cardExpMonth,
      expYear: data.cardExpYear,
    });
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  const statusLabel = (() => {
    if (tier === "pro" && cancelAtPeriodEnd) return `Cancels on ${formatDate(periodEnd)}`;
    if (isPro) return `Renews on ${formatDate(periodEnd)}`;
    if (status === "past_due") return "Payment past due — update your card to keep Pro";
    return "Free tier — no charges";
  })();

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold text-gray-900">Billing</h1>

      {/* Plan summary */}
      <div className="mt-6 rounded-2xl border border-gray-100 bg-white p-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-gray-900">
              {tier === "pro" ? "Candid Pro" : "Candid Free"}
            </h3>
            <p className="mt-0.5 text-sm text-gray-500">{statusLabel}</p>
          </div>
          <span
            className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${
              tier === "pro" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"
            }`}
          >
            {tier === "pro" ? "Pro" : "Free"}
          </span>
        </div>

        <div className="mt-4">
          {!isPro && (
            <button
              type="button"
              onClick={() =>
                openSubscribe({
                  surface: "dispute",
                  ribbon: {
                    headline: "Unlock Candid Pro",
                    subline: "Unlimited dispute letters, lawyer directory, community pricing.",
                  },
                  onSuccess: async () => {
                    await waitFor((s) => s.tier === "pro" && (s.status === "active" || s.status === "trialing"));
                    await reloadCard();
                  },
                })
              }
              disabled={redirecting}
              className="w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
            >
              {redirecting ? "Opening checkout…" : "Upgrade to Pro"}
            </button>
          )}
          {isPro && !cancelAtPeriodEnd && (
            <button
              type="button"
              onClick={() => setCancelOpen(true)}
              className="w-full rounded-xl border border-gray-200 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700"
            >
              Cancel subscription
            </button>
          )}
          {isPro && cancelAtPeriodEnd && (
            <button
              type="button"
              onClick={handleResume}
              disabled={resumeSubmitting}
              className="w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
            >
              {resumeSubmitting ? "Resuming…" : "Resume subscription"}
            </button>
          )}
        </div>
      </div>

      {/* Payment method */}
      <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Payment method</h3>
          {card?.last4 && (
            <button
              type="button"
              onClick={() => setUpdateCardOpen(true)}
              className="text-xs font-medium text-blue-600 hover:text-blue-700"
            >
              Update
            </button>
          )}
        </div>

        {cardLoading ? (
          <div className="flex items-center justify-center py-4">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
          </div>
        ) : card?.last4 ? (
          <div className="flex items-center gap-3 rounded-xl bg-gray-50 p-3">
            <div className="flex h-7 w-10 items-center justify-center rounded bg-gradient-to-br from-gray-700 to-gray-900">
              <span className="text-[10px] font-bold uppercase text-white">
                {titleCaseBrand(card.brand)}
              </span>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">•••• {card.last4}</p>
              <p className="text-xs text-gray-400">
                Expires {String(card.expMonth ?? "--").padStart(2, "0")}/
                {card.expYear ?? "--"}
              </p>
            </div>
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-gray-500">
              Add a card so you&apos;re ready to upgrade to Candid Pro.
            </p>
            <button
              type="button"
              onClick={() => setUpdateCardOpen(true)}
              className="w-full rounded-xl border-2 border-dashed border-gray-200 py-2.5 text-sm font-medium text-gray-500 transition-colors hover:border-blue-300 hover:text-blue-600"
            >
              + Add credit or debit card
            </button>
          </>
        )}
      </div>

      {/* Invoice history */}
      <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-5">
        <h3 className="mb-3 text-sm font-semibold text-gray-900">Invoice history</h3>
        <InvoiceList />
      </div>

      <UpdatePaymentMethodFlow
        isOpen={updateCardOpen}
        onSuccess={async () => {
          setUpdateCardOpen(false);
          await reloadCard();
        }}
        onCancel={() => setUpdateCardOpen(false)}
      />
      <CancelSubscriptionDialog
        isOpen={cancelOpen}
        periodEnd={periodEnd}
        onConfirmed={async () => {
          setCancelOpen(false);
          await refresh();
        }}
        onCancel={() => setCancelOpen(false)}
      />
      {renderSubscribe()}
    </div>
  );
}
