"use client";

/**
 * /billing — Subscription management surface (B2.2 redesign).
 *
 * Composes the design's billing page: header + 2-col hero (PlanCard + UsageStatsCard)
 * + Payment method section (VisualCreditCard + meta sidebar) + tabbed Invoice
 * history + Stripe trust footer + 3 modals (UpdatePaymentMethodFlow,
 * CancelModal, ChangePlanModal) + embedded subscribe trigger.
 *
 * Architecture preservation (NON-NEGOTIABLE per Candid_Context + S114):
 *   - Stripe Elements for card capture (PCI scope; never raw inputs)
 *   - Webhook (`/api/stripe/webhook`) is source of truth; mutations write-through
 *     for optimistic UI then reconcile from webhook
 *   - cancel_at_period_end = true (never immediate cancellation)
 *   - Embedded subscribe flow (no off-site redirect)
 *   - useSubscription + useSubscribeTrigger hook surface preserved
 *
 * See Candid_Context "Subscription & Billing" + plans/phase2_implementation.md §B2.2.
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { useSubscription } from "@/lib/subscription/use-subscription";
import { useSubscribeTrigger } from "@/components/billing/SubscribeTrigger";
import { UpdatePaymentMethodFlow } from "@/components/billing/UpdatePaymentMethodFlow";
import { CancelModal } from "@/components/billing/CancelModal";
import { ChangePlanModal } from "@/components/billing/ChangePlanModal";
import { InvoiceList } from "@/components/billing/InvoiceList";
import { PlanCard } from "@/components/billing/PlanCard";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";
import { useMinHoldLoading } from "@/lib/loading/use-min-hold";
import { UsageStatsCard } from "@/components/billing/UsageStatsCard";
import { VisualCreditCard } from "@/components/billing/VisualCreditCard";

interface UsageData {
  totalRecovered: number;
  disputesDrafted: number;
  billsAudited: number;
  plansParsed: number;
  multiplier: number;
}

const EMPTY_USAGE: UsageData = {
  totalRecovered: 0,
  disputesDrafted: 0,
  billsAudited: 0,
  plansParsed: 0,
  multiplier: 0,
};

export default function BillingPage() {
  const { user } = useAuth();
  const {
    tier,
    status,
    tierCycle,
    loading,
    isPro,
    cancelAtPeriodEnd,
    periodEnd,
    cardholderName,
    pastDueRetryLog,
    refresh,
    waitFor,
  } = useSubscription();
  const { trigger: openSubscribe, render: renderSubscribe, redirecting } = useSubscribeTrigger();

  const [cardBrand, setCardBrand] = useState<string | null>(null);
  const [cardLast4, setCardLast4] = useState<string | null>(null);
  const [cardExpMonth, setCardExpMonth] = useState<number | null>(null);
  const [cardExpYear, setCardExpYear] = useState<number | null>(null);
  const [cardLoading, setCardLoading] = useState(true);

  const [usage, setUsage] = useState<UsageData>(EMPTY_USAGE);
  const [usageLoading, setUsageLoading] = useState(true);

  const [updateCardOpen, setUpdateCardOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [changePlanOpen, setChangePlanOpen] = useState(false);
  const [resumeSubmitting, setResumeSubmitting] = useState(false);

  const loadCard = useCallback(async () => {
    if (!user) return;
    const token = await user.firebaseUser.getIdToken();
    const res = await fetch("/api/subscription/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      setCardBrand(null);
      setCardLast4(null);
      setCardExpMonth(null);
      setCardExpYear(null);
      setCardLoading(false);
      return;
    }
    const data = await res.json();
    setCardBrand(data.cardBrand);
    setCardLast4(data.cardLast4);
    setCardExpMonth(data.cardExpMonth);
    setCardExpYear(data.cardExpYear);
    setCardLoading(false);
  }, [user]);

  const loadUsage = useCallback(async () => {
    if (!user) return;
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/billing/usage", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setUsage(EMPTY_USAGE);
      } else {
        const data = await res.json();
        setUsage({
          totalRecovered: Number(data.totalRecovered) || 0,
          disputesDrafted: Number(data.disputesDrafted) || 0,
          billsAudited: Number(data.billsAudited) || 0,
          plansParsed: Number(data.plansParsed) || 0,
          multiplier: Number(data.multiplier) || 0,
        });
      }
    } catch (err) {
      console.warn("[billing] usage load failed:", err);
      setUsage(EMPTY_USAGE);
    } finally {
      setUsageLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    loadCard();
    loadUsage();
  }, [user, loadCard, loadUsage]);

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

  function handleUpgrade() {
    openSubscribe({
      surface: "dispute",
      ribbon: {
        headline: "Unlock Candid Pro",
        subline: "Unlimited dispute letters, lawyer directory, community pricing.",
      },
      onSuccess: async () => {
        await waitFor(
          (s) => s.tier === "pro" && (s.status === "active" || s.status === "trialing"),
        );
        await loadCard();
        await loadUsage();
      },
    });
  }

  const showLoader = useMinHoldLoading(loading);
  if (showLoader) {
    return <CubeLoaderBuilding />;
  }

  return (
    <div className="mx-auto max-w-5xl pb-12">
      {/* Header */}
      <div className="mb-8">
        <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-gray-500">
          Candid billing
        </div>
        <h1 className="mt-1 text-2xl font-bold text-gray-900">Your subscription</h1>
        <p className="mt-2 max-w-2xl text-sm text-gray-600">
          Candid Pro powers unlimited audits and dispute letters. Manage your
          plan, payment method, and invoices below.
        </p>
      </div>

      {/* Hero — PlanCard + UsageStatsCard */}
      <div className="grid gap-4 md:grid-cols-2">
        <PlanCard
          tier={tier}
          status={status}
          tierCycle={tierCycle}
          cancelAtPeriodEnd={cancelAtPeriodEnd}
          periodEnd={periodEnd}
          pastDueRetryLog={pastDueRetryLog}
          onUpgrade={handleUpgrade}
          onChangePlan={() => setChangePlanOpen(true)}
          onCancel={() => setCancelOpen(true)}
          onResume={handleResume}
          onUpdateCard={() => setUpdateCardOpen(true)}
          resumeSubmitting={resumeSubmitting}
          upgradeDisabled={redirecting}
        />
        <UsageStatsCard
          totalRecovered={usage.totalRecovered}
          disputesDrafted={usage.disputesDrafted}
          billsAudited={usage.billsAudited}
          plansParsed={usage.plansParsed}
          multiplier={usage.multiplier}
          loading={usageLoading}
        />
      </div>

      {/* Payment method */}
      <div className="mt-6 rounded-2xl border border-gray-100 bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-gray-500">
              Payment method
            </div>
            <h2 className="mt-1 text-base font-bold text-gray-900">How you pay</h2>
          </div>
          {cardLast4 && (
            <button
              type="button"
              onClick={() => setUpdateCardOpen(true)}
              className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Update card
            </button>
          )}
        </div>

        {cardLoading ? (
          <div className="flex items-center justify-center py-6">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
          </div>
        ) : cardLast4 ? (
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
            <VisualCreditCard
              brand={cardBrand}
              last4={cardLast4}
              cardholderName={cardholderName}
              expMonth={cardExpMonth}
              expYear={cardExpYear}
            />
            <div className="flex-1 space-y-2.5 text-sm">
              <PayMetaRow
                label="Default for renewal"
                value={
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                    <svg
                      className="h-2.5 w-2.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                    Default
                  </span>
                }
              />
              <PayMetaRow label="Billing email" value={user?.email || "—"} />
              <PayMetaRow
                label="Receipts"
                value="Sent automatically after each charge"
              />
            </div>
          </div>
        ) : (
          <div>
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
          </div>
        )}
      </div>

      {/* Invoices */}
      <div className="mt-6 rounded-2xl border border-gray-100 bg-white p-5">
        <div className="mb-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-gray-500">
            Invoices
          </div>
          <h2 className="mt-1 text-base font-bold text-gray-900">Receipt history</h2>
        </div>
        <InvoiceList tierCycle={tierCycle} />
      </div>

      {/* Trust footer */}
      <div className="mt-6 grid gap-3 rounded-2xl border border-gray-100 bg-gray-50/50 p-5 sm:grid-cols-2">
        <TrustRow
          icon={
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
          }
          title="Secured by Stripe"
          body="Card details never touch Candid servers. PCI DSS Level 1 compliant."
        />
        <TrustRow
          icon={
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
          }
          title="Cancel anytime"
          body="One click. Keep access through your period end — never an immediate cutoff."
        />
      </div>

      {/* Modals */}
      <UpdatePaymentMethodFlow
        isOpen={updateCardOpen}
        currentCard={{
          brand: cardBrand,
          last4: cardLast4,
          expMonth: cardExpMonth,
          expYear: cardExpYear,
          cardholderName,
        }}
        onSuccess={async () => {
          setUpdateCardOpen(false);
          await loadCard();
          await refresh();
        }}
        onCancel={() => setUpdateCardOpen(false)}
      />
      <CancelModal
        open={cancelOpen}
        periodEnd={periodEnd}
        totalRecovered={usage.totalRecovered}
        onClose={() => setCancelOpen(false)}
        onCanceled={async () => {
          await refresh();
        }}
      />
      <ChangePlanModal
        open={changePlanOpen && isPro}
        currentCycle={tierCycle}
        onClose={() => setChangePlanOpen(false)}
        onChanged={async () => {
          await refresh();
          await loadUsage();
        }}
        onDowngradeToFree={() => {
          setChangePlanOpen(false);
          setCancelOpen(true);
        }}
      />
      {renderSubscribe()}
    </div>
  );
}

function PayMetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-gray-100 pb-2 last:border-b-0 last:pb-0">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-gray-500">
        {label}
      </div>
      <div className="text-sm text-gray-700">{value}</div>
    </div>
  );
}

function TrustRow({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-white text-gray-700 ring-1 ring-gray-200">
        <span className="h-4 w-4">{icon}</span>
      </div>
      <div>
        <div className="text-sm font-semibold text-gray-900">{title}</div>
        <div className="mt-0.5 text-xs text-gray-600">{body}</div>
      </div>
    </div>
  );
}
