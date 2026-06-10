/**
 * GET /api/disputes/outcome — Fetch the authenticated user's dispute history.
 * POST /api/disputes/outcome — Update a dispute's outcome (status, amount recovered).
 *
 * S74 hardening: both methods now require a Firebase bearer token and verify the
 * caller owns the target dispute. Prior to S74 the POST handler accepted any
 * disputeId from any caller, and GET took `userId` as a URL parameter — both
 * routes leaked across users. The "mark sent" UI added in S74 reuses POST with
 * `status='filed'`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { updateDisputeOutcome, getUserDisputes } from "@/lib/disputes/persist";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import {
  computeCooldownUntil,
  computeEvidenceFingerprint,
  loadFingerprintInputForClaim,
} from "@/lib/disputes/evidence-fingerprint";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

async function resolveUserId(supabase: ReturnType<typeof createServerClient>, firebaseUid: string): Promise<string | null> {
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", firebaseUid)
    .single();
  return user?.id ?? null;
}

export async function GET(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();
  const userId = await resolveUserId(supabase, decoded.uid);
  if (!userId) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const result = await getUserDisputes(supabase, userId);
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  try {
    const decoded = await getAuthUser(req);
    if (!decoded) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const {
      disputeId,
      status,
      amountRecovered,
      resolutionDate,
      strategyNotes,
      // S74.6 D5 — optional capture of the alternative code the insurer paid on.
      // Only persisted when status='won_on_escalation' (paired with status
      // because pre-escalation wins typically use the original code).
      recodedAs,
    } = await req.json();

    if (!disputeId || !status) {
      return NextResponse.json(
        { error: "disputeId and status are required" },
        { status: 400 }
      );
    }

    // S74: the new lifecycle vocabulary (Session 35+) coexists with the legacy
    // statuses. The mark-sent button on the disputes toolbar POSTs with
    // status='filed' to transition the dispute from drafted → filed.
    const validStatuses = [
      "filed",
      "in_progress",
      "won",
      "lost",
      "settled",
      "withdrawn",
      "won_on_escalation",
      "settled_on_escalation",
      "dispute_letter_drafted",
      "court_documentation_drafted",
    ];
    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        { error: `status must be one of: ${validStatuses.join(", ")}` },
        { status: 400 }
      );
    }

    const supabase = createServerClient();
    const userId = await resolveUserId(supabase, decoded.uid);
    if (!userId) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Ownership check — verify the dispute belongs to the authenticated user
    // BEFORE running the update. Without this guard any authenticated user
    // could mutate any dispute by knowing its UUID.
    const { data: existing } = await supabase
      .from("dispute_outcomes")
      .select("id, user_id, status, filed_date, claim_id, letter_content, sent_at")
      .eq("id", disputeId)
      .single();

    if (!existing || existing.user_id !== userId) {
      return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
    }

    const success = await updateDisputeOutcome(supabase, disputeId, {
      status,
      amountRecovered: amountRecovered ?? undefined,
      resolutionDate: resolutionDate ?? undefined,
      strategyNotes: strategyNotes ?? undefined,
    });

    if (!success) {
      return NextResponse.json({ error: "Failed to update dispute" }, { status: 500 });
    }

    // S74.6 D5 — capture recoded_as_code on won_on_escalation outcomes. Writes
    // directly to dispute_outcomes columns (mig 094); separate from
    // updateDisputeOutcome which doesn't yet know about these columns. We
    // intentionally accept the recodedAs only when status='won_on_escalation'
    // so the "insurer paid on a different code" signal is honest — pre-
    // escalation wins typically pay on the original code.
    if (
      status === "won_on_escalation" &&
      recodedAs &&
      typeof recodedAs.code === "string" &&
      typeof recodedAs.codeType === "string" &&
      recodedAs.code.trim().length > 0 &&
      recodedAs.codeType.trim().length > 0
    ) {
      const recodedCode = recodedAs.code.trim();
      const recodedCodeType = recodedAs.codeType.trim();
      try {
        await supabase
          .from("dispute_outcomes")
          .update({
            recoded_as_code: recodedCode,
            recoded_as_code_type: recodedCodeType,
          })
          .eq("id", disputeId);

        // S74.6 D5 §E.1 — cast `dispute_won_recoding` vote on the
        // (recodedAs.code, slug) billing_code_identity row so the peer-code
        // engine + Pattern 1 #3 promotion threshold gains real-world signal
        // from "the insurer paid on this alternative code." Pattern 1 #15
        // gated inside the helper; non-verified users no-op. Non-blocking on
        // failure — the recoded_as_code columns are already written above
        // and provide the dispute-letter alt-code surface independent of the
        // flywheel vote.
        try {
          const { recordDisputeWonRecoding } = await import(
            "@/lib/parser/code-identity-promotion"
          );
          const result = await recordDisputeWonRecoding({
            userId,
            disputeId,
            recodedAsCode: recodedCode,
            recodedAsCodeType: recodedCodeType,
          });
          if (!result.contributedToFlywheel) {
            console.log(
              "[disputes/outcome] dispute_won_recoding vote skipped:",
              result.reason,
            );
          }
        } catch (voteErr) {
          console.error(
            "[disputes/outcome] dispute_won_recoding vote write failed (non-fatal):",
            voteErr,
          );
        }
      } catch (err) {
        console.error(
          "[disputes/outcome] D5 recoded_as_code capture failed (non-fatal):",
          err,
        );
      }
    }

    // S74.5 D16 — Mark-as-Sent snapshot capture. When the transition is
    // drafted → filed AND sent_at hasn't already been captured (idempotent
    // re-clicks shouldn't reset the cooldown clock), snapshot the current
    // letter_content into sent_letter + set sent_at + cooldown_until +
    // refresh evidence_fingerprint. Gated on flag so OFF preserves
    // pre-S74.5 behavior exactly.
    if (status === "filed" && !existing.sent_at) {
      try {
        const flywheelOn = await isFeatureEnabled(
          "s74_5_categorization_flywheel_v1",
        );
        if (flywheelOn) {
          const sentAt = new Date();
          const cooldownUntil = computeCooldownUntil(sentAt, 30);

          let fingerprint: string | null = null;
          if (existing.claim_id) {
            const fpInput = await loadFingerprintInputForClaim(
              supabase,
              existing.claim_id as string,
              userId,
            );
            if (fpInput) fingerprint = computeEvidenceFingerprint(fpInput);
          }

          await supabase
            .from("dispute_outcomes")
            .update({
              sent_letter: existing.letter_content,
              sent_at: sentAt.toISOString(),
              cooldown_until: cooldownUntil.toISOString(),
              evidence_fingerprint:
                fingerprint ?? undefined,
              last_refresh_at: sentAt.toISOString(),
            })
            .eq("id", disputeId);
        }
      } catch (err) {
        console.error(
          "[disputes/outcome] D16 sent-letter snapshot failed (non-fatal):",
          err,
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Dispute outcome update error:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
