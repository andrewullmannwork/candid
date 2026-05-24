"use client";
/**
 * Past-due retry log — 3-row list of recent failed charges + next scheduled
 * retry attempt. Renders only inside the past-due PlanCard variant.
 *
 * Data sourced from Stripe via /api/subscription/me when subscription_status
 * is 'past_due' (charges.list + invoices.list with status='open').
 */

import type { PastDueRetryEvent } from "@/lib/subscription/use-subscription";

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function PastDueRetryLog({ events }: { events: PastDueRetryEvent[] }) {
  if (events.length === 0) return null;

  return (
    <ul className="space-y-1.5">
      {events.map((e, i) => (
        <li
          key={`${e.kind}-${e.at}-${i}`}
          className="flex flex-wrap items-center gap-1.5 text-[12px] text-gray-700"
        >
          <span className="font-medium text-gray-900">{formatDateTime(e.at)}</span>
          <span className="text-gray-400">·</span>
          {e.cardLabel && (
            <>
              <span>{e.cardLabel}</span>
              <span className="text-gray-400">·</span>
            </>
          )}
          <span
            className={
              e.kind === "failed"
                ? "font-medium text-red-700"
                : "font-medium text-amber-700"
            }
          >
            {e.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}
