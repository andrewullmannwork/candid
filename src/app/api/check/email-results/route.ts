import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { createServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/security/require-authenticated-user";
import { userScoped, selectOwnedChildren } from "@/lib/security/user-scoped";
import { consumeRateLimit } from "@/lib/security/durable-rate-limit";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { emitCaseEvents } from "@/lib/case/case-events";
import { sendCheckResultsEmail } from "@/lib/email/onboarding-emails";

/**
 * S316 — "Email me my results" for the anonymous /check flow.
 *
 * ANONYMOUS-ONLY by design (the mirror of /api/disputes/generate's Tier-3
 * floor): an authed user's results live in their account, and this route's
 * whole reason to exist is giving the no-account visitor a durable copy.
 * Sends ONLY to the stored users.contact_email — a posted address is used
 * exclusively to FILL an empty contact_email (same validation as auth/sync),
 * never to redirect a send when one is already on file. One-shot posture:
 * user-triggered, idempotency-keyed per claim, rate-limited per account.
 *
 * Findings come from the persisted line-item audit output (the same rows the
 * results table renders). The live cost-share engine is deliberately NOT
 * re-derived here — for the /check flow the audit just ran, so the staleness
 * window is minutes, and every amount carries the "up to" hedge.
 */

const CONTACT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 1) return `•••${email.slice(at)}`;
  return `${email[0]}•••${email.slice(at)}`;
}

interface StoredFinding {
  type?: string;
  title?: string;
  description?: string;
  estimatedOvercharge?: number;
  dismissed?: boolean;
}

export async function POST(req: NextRequest) {
  try {
    // One-flag kill switch: this endpoint is part of the anonymous /check
    // surface — flag OFF kills it with the rest (sync already refuses NEW
    // anonymous sessions when OFF; this closes the pre-existing-session gap).
    if (!(await isFeatureEnabled("anonymous_bill_check_v1"))) {
      return NextResponse.json({ error: "Not available." }, { status: 403 });
    }

    const auth = await requireAuthenticatedUser(req);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!auth.isAnonymous) {
      return NextResponse.json(
        { error: "Your results already live in your account." },
        { status: 403 },
      );
    }
    const userId = auth.id;

    const supabase = createServerClient();
    const { data: userRow } = await supabase
      .from("users")
      .select("contact_email")
      .eq("id", userId)
      .maybeSingle();

    const rl = await consumeRateLimit(
      `user:check-results-email:${userId}`,
      { windowSeconds: 86_400, maxAttempts: 3 },
      supabase,
    );
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Result emails are limited for today. Your results stay available on this page." },
        { status: 429 },
      );
    }

    const { claimId, email: postedEmail, summary } = (await req.json()) as {
      claimId?: string;
      email?: string;
      // S316 round 2 — the SCREEN's own recovery summary (ClaimDetail reports
      // exactly what it rendered). His live test caught the email saying
      // "nothing stood out" beside a page showing $129.07: the persisted
      // audit rows are a DIFFERENT finding family than the live cost-share
      // engine. Mailing the screen's payload makes agreement structural.
      // Self-addressed only (the send goes to the user's own stored contact),
      // so a tampered payload can only mislead its own author; every number
      // is hedged and sanitized below.
      summary?: {
        potentialRecovery?: number;
        shouldOwe?: number;
        // S318 — priced-lines floor + unpriced count (the approved range
        // sentence); sanitized like every other number below.
        pricedFloor?: number | null;
        unpricedCount?: number;
        lines?: { label?: string; amount?: number | null }[];
      };
    };
    if (!claimId || typeof claimId !== "string") {
      return NextResponse.json({ error: "Missing claimId" }, { status: 400 });
    }

    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 10_000_000 ? v : null;
    const recoveryTotal = num(summary?.potentialRecovery);
    const shouldOwe = num(summary?.shouldOwe);
    const pricedFloor = num(summary?.pricedFloor);
    const unpricedCount =
      typeof summary?.unpricedCount === "number" &&
      Number.isInteger(summary.unpricedCount) &&
      summary.unpricedCount >= 0 &&
      summary.unpricedCount <= 100
        ? summary.unpricedCount
        : 0;
    const screenLines = (Array.isArray(summary?.lines) ? summary.lines : [])
      .slice(0, 8)
      .flatMap((l) => {
        const label = typeof l?.label === "string" ? l.label.trim().slice(0, 120) : "";
        return label ? [{ label, amount: num(l?.amount) }] : [];
      });

    const { data: claim } = await userScoped(supabase, userId)
      .table("claims")
      .select("id, total_billed, date_of_service, metadata")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim) {
      return NextResponse.json({ error: "Claim not found" }, { status: 404 });
    }

    // Stored contact wins unconditionally; a posted address only fills a gap.
    let contactEmail = (userRow?.contact_email as string | null) ?? null;
    if (!contactEmail) {
      const candidate =
        typeof postedEmail === "string" && CONTACT_EMAIL_RE.test(postedEmail.trim())
          ? postedEmail.trim().slice(0, 320)
          : null;
      if (!candidate) {
        return NextResponse.json({ error: "email_required" }, { status: 400 });
      }
      const { error: writeErr } = await supabase
        .from("users")
        .update({ contact_email: candidate })
        .eq("id", userId);
      if (writeErr) {
        console.error("[check/email-results] contact_email write failed:", writeErr.message);
        return NextResponse.json({ error: "Couldn't save that address. Try again." }, { status: 500 });
      }
      contactEmail = candidate;
    }

    const lineItems = await selectOwnedChildren(
      supabase,
      userId,
      "claim_line_items",
      [claimId],
      "id, description, metadata",
    );

    const findings: { label: string; amount: number | null }[] = [];
    for (const li of lineItems ?? []) {
      const meta = (li.metadata ?? {}) as Record<string, unknown>;
      const stored = (meta.auditFindings ?? []) as StoredFinding[];
      for (const f of stored) {
        if (f.dismissed) continue;
        // title is the one-liner the results table renders; description is the
        // verbose body — same display priority as ClaimDetail.
        const label =
          (typeof f.title === "string" && f.title.trim()) ||
          (typeof f.description === "string" && f.description.trim()) ||
          (typeof f.type === "string" && f.type.replace(/_/g, " ")) ||
          "An item worth reviewing";
        const amount =
          typeof f.estimatedOvercharge === "number" && Number.isFinite(f.estimatedOvercharge)
            ? f.estimatedOvercharge
            : null;
        findings.push({ label, amount });
      }
    }

    const claimMeta = (claim.metadata ?? {}) as Record<string, unknown>;
    const providerMeta = (claimMeta.provider ?? {}) as Record<string, unknown>;
    const providerName = typeof providerMeta.name === "string" ? providerMeta.name : null;

    // The email's finding list = the SCREEN's per-line recovery rows UNION the
    // persisted audit-rule findings (duplicates/benchmarks — a different
    // family the screen also shows), deduped by label.
    const seenLabels = new Set(screenLines.map((l) => l.label.toLowerCase()));
    const merged = [
      ...screenLines,
      ...findings.filter((f) => !seenLabels.has(f.label.toLowerCase())),
    ];

    // Content-aware idempotency: a double-click (identical results) dedupes
    // at Resend, but a re-send after the results CHANGED (plan added → new
    // findings) is a different key and goes out. Rate limit still caps volume.
    const shownFindings = merged.slice(0, 8);
    const contentFingerprint = createHash("sha256")
      .update(
        // S318 — the floor/count join the fingerprint: confirming a rate
        // changes the rendered sentence, so the re-send is a different key.
        `${recoveryTotal ?? ""}|${shouldOwe ?? ""}|${pricedFloor ?? ""}|${unpricedCount}|` +
          shownFindings.map((f) => `${f.label}:${f.amount ?? ""}`).join("|"),
      )
      .digest("hex")
      .slice(0, 12);

    const sent = await sendCheckResultsEmail(contactEmail, {
      providerName,
      billedTotal: typeof claim.total_billed === "number" ? claim.total_billed : null,
      serviceDate: typeof claim.date_of_service === "string" ? claim.date_of_service : null,
      recoveryTotal,
      shouldOwe,
      pricedFloor,
      unpricedCount,
      findings: shownFindings,
      idempotencyKey: `check-results:${claimId}:${contentFingerprint}`,
    });
    if (!sent) {
      return NextResponse.json(
        { error: "Couldn't send the email right now. Your results stay available on this page." },
        { status: 502 },
      );
    }

    // Rule #10 — the spine records the send (fail-soft, refs-only), the same
    // metering posture as case_file_downloaded. Answers "did they get their
    // results?" and feeds the check→convert funnel without a new table.
    await emitCaseEvents(supabase, userId, [
      { claimId, kind: "check_results_emailed", payload: { fingerprint: contentFingerprint } },
    ]);

    return NextResponse.json({ sentTo: maskEmail(contactEmail) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[check/email-results] Unhandled error:", message);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
