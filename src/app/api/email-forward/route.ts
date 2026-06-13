import { NextResponse } from "next/server";

// ── Inbound email-forward: DISABLED (S199 — legal/compliance, "E3") ──────────
//
// This endpoint previously received a Resend inbound-email webhook, fetched the
// forwarded message body from the Resend API, and re-sent it to an operations
// mailbox. Forwarded insurer emails carry consumer health data (CHD), and the
// destination was an uncovered personal mailbox, so the feature is turned OFF
// until a covered destination and a data-processing agreement are in place. The
// consent/privacy text was updated in the same change to remove the
// email-forward disclosures.
//
// The prior implementation (Svix signature verification, PHI-redacted logging,
// Resend fetch + re-send) is preserved in git history before S199 if it needs
// to be restored. We return HTTP 200 so Resend does not retry the webhook; the
// payload is ignored — no fetch, no re-send, and no logging of its contents.
export async function POST() {
  return NextResponse.json({ received: true, disabled: true });
}
