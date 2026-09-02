/**
 * fees — the member-paid lane's money rules, PURE where they can be (S330).
 *
 * The fee agreement (consent-documents.ts) promises:
 *   - cancel within THREE BUSINESS DAYS of signing → full refund of any fee paid
 *   - if Candid ends the engagement on a conversion trigger BEFORE transmitting
 *     the appeal → full refund
 *   - declined at intake → no fee
 * These are the only refund paths; the operator's refund action names which one.
 */
import { businessDaysUntil, parseDateOnly } from "./business-days";

export type RefundBasis = "member_cancel_window" | "converted_before_transmit" | "declined_at_intake" | "operator_discretion";

export interface PaymentFact {
  status?: string;
  intentId?: string;
  amountCents?: number;
  at?: string;
  refund?: { id: string; amountCents: number; at: string; basis: RefundBasis; by: string | null };
}

export function paymentFactOf(metadata: Record<string, unknown>): PaymentFact | null {
  const p = metadata.payment;
  return p && typeof p === "object" ? (p as PaymentFact) : null;
}

/**
 * Business days elapsed since the member signed: whole weekdays strictly AFTER
 * the signing date up to and including today (date-only, calendar). Counted
 * forward from the signing date so the signing day itself is day 0 and a
 * weekend contributes nothing — the same walk the R18 runway uses, pointed
 * the other way.
 */
export function businessDaysSinceSigned(signedAt: string | null, now: Date): number | null {
  if (!signedAt) return null;
  const signed = parseDateOnly(signedAt.slice(0, 10));
  if (!signed) return null;
  return businessDaysUntil(signed, now.toISOString().slice(0, 10));
}

/** The member's own cancel window: within three business days of signing. */
export function withinCancelWindow(signedAt: string | null, now: Date): boolean {
  const d = businessDaysSinceSigned(signedAt, now);
  return d !== null && d <= 3;
}

/** A refund is owed when the fee was paid, not yet refunded, and a basis applies. */
export function refundable(payment: PaymentFact | null): boolean {
  return !!payment && payment.status === "succeeded" && !payment.refund && typeof payment.intentId === "string" && (payment.amountCents ?? 0) > 0;
}
