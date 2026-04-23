"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

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

const STATUS_STYLE: Record<string, string> = {
  paid: "text-green-700 bg-green-50",
  open: "text-amber-700 bg-amber-50",
  uncollectible: "text-red-700 bg-red-50",
  void: "text-gray-600 bg-gray-50",
  draft: "text-gray-600 bg-gray-50",
};

export function InvoiceList() {
  const { user } = useAuth();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <ul className="divide-y divide-gray-100">
      {invoices.map((inv, i) => {
        const statusKey = (inv.status || "").toLowerCase();
        const statusClass = STATUS_STYLE[statusKey] || "text-gray-600 bg-gray-50";
        return (
          <li key={inv.id ?? inv.number ?? `row-${i}`} className="flex items-center justify-between py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900">
                ${(inv.total / 100).toFixed(2)}
                {inv.number && <span className="ml-2 text-xs text-gray-400">#{inv.number}</span>}
              </p>
              <p className="text-xs text-gray-500">{formatDate(inv.created)}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${statusClass}`}>
                {inv.status ?? "unknown"}
              </span>
              {inv.pdfUrl && (
                <a
                  href={inv.pdfUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-medium text-blue-600 hover:text-blue-700"
                >
                  Download
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
