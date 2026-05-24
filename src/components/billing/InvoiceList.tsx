"use client";

/**
 * Invoice list — tabbed (All / Paid) view of the user's Stripe invoices.
 *
 * Data sourced from /api/stripe/invoices (server reads via Stripe API). Each
 * row exposes the Stripe-hosted PDF as a "Receipt" link when available.
 */

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { cn } from "@/lib/utils/cn";

interface Invoice {
  id: string | null;
  number: string | null;
  total: number;
  amountDue: number;
  amountPaid: number;
  status: string | null;
  pdfUrl: string | null;
  hostedUrl: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  created: string | null;
}

type Tab = "all" | "paid";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function describeInvoice(inv: Invoice, tierCycle: "monthly" | "annual" | null): string {
  if (tierCycle === "annual") return "Candid Pro · Annual";
  return "Candid Pro · Monthly";
}

const STATUS_STYLE: Record<string, string> = {
  paid: "text-emerald-700 bg-emerald-50",
  open: "text-amber-700 bg-amber-50",
  uncollectible: "text-red-700 bg-red-50",
  void: "text-gray-600 bg-gray-50",
  draft: "text-gray-600 bg-gray-50",
};

interface InvoiceListProps {
  tierCycle?: "monthly" | "annual" | null;
}

export function InvoiceList({ tierCycle = null }: InvoiceListProps = {}) {
  const { user } = useAuth();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    async function load() {
      try {
        const token = await user!.firebaseUser.getIdToken();
        const res = await fetch("/api/stripe/invoices", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error || "Failed to load invoices");
          return;
        }
        setInvoices(data.invoices || []);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load invoices");
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const counts = useMemo(() => {
    const all = invoices?.length ?? 0;
    const paid = (invoices ?? []).filter((i) => (i.status || "").toLowerCase() === "paid").length;
    return { all, paid };
  }, [invoices]);

  const filtered = useMemo(() => {
    if (!invoices) return [];
    if (tab === "all") return invoices;
    return invoices.filter((i) => (i.status || "").toLowerCase() === "paid");
  }, [invoices, tab]);

  if (error) {
    return <p className="text-xs text-red-600">{error}</p>;
  }

  if (invoices === null) {
    return (
      <div className="flex items-center justify-center py-6">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
      </div>
    );
  }

  if (invoices.length === 0) {
    return (
      <p className="text-xs text-gray-500">
        No invoices yet — your first one will appear after your Pro subscription renews.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-1.5">
        <TabButton
          active={tab === "all"}
          onClick={() => setTab("all")}
          label="All"
          count={counts.all}
        />
        <TabButton
          active={tab === "paid"}
          onClick={() => setTab("paid")}
          label="Paid"
          count={counts.paid}
        />
      </div>

      <div className="hidden grid-cols-[1fr_1.5fr_auto_auto_auto] items-center gap-3 border-b border-gray-100 pb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-gray-400 sm:grid">
        <div>Date</div>
        <div>Description</div>
        <div className="text-right">Amount</div>
        <div>Status</div>
        <div />
      </div>

      <ul className="divide-y divide-gray-100">
        {filtered.map((inv, i) => {
          const statusKey = (inv.status || "").toLowerCase();
          const statusClass = STATUS_STYLE[statusKey] || "text-gray-600 bg-gray-50";
          return (
            <li
              key={inv.id ?? inv.number ?? `row-${i}`}
              className="grid grid-cols-2 items-center gap-x-3 gap-y-1 py-3 sm:grid-cols-[1fr_1.5fr_auto_auto_auto]"
            >
              <div className="text-xs text-gray-700 sm:text-sm">{formatDate(inv.created)}</div>
              <div className="text-xs text-gray-700 sm:text-sm">
                <div>{describeInvoice(inv, tierCycle)}</div>
                {inv.number && (
                  <div className="text-[11px] text-gray-400">#{inv.number}</div>
                )}
              </div>
              <div className="text-right text-sm font-semibold text-gray-900">
                ${(inv.total / 100).toFixed(2)}
              </div>
              <div>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize",
                    statusClass,
                  )}
                >
                  {inv.status ?? "unknown"}
                </span>
              </div>
              <div className="text-right">
                {inv.pdfUrl ? (
                  <a
                    href={inv.pdfUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
                  >
                    <svg
                      className="h-3 w-3"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
                    </svg>
                    Receipt
                  </a>
                ) : (
                  <span className="text-[11px] text-gray-400">—</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 text-[11px] text-gray-500">
        All invoices are stored for 7 years.
      </div>
    </div>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}

function TabButton({ active, onClick, label, count }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-gray-900 text-white"
          : "bg-gray-100 text-gray-700 hover:bg-gray-200",
      )}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 text-[10px] font-bold",
          active ? "bg-white/20" : "bg-white",
        )}
      >
        {count}
      </span>
    </button>
  );
}
