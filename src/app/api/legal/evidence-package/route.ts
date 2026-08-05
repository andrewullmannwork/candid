/**
 * GET /api/legal/evidence-package — Compile and download evidence package
 *
 * Query params:
 *   - claimId: claim UUID (required)
 *   - disputeId: dispute UUID (optional — triggers letterContent embed via Section 0)
 *   - format: "text" | "pdf" (default "text")
 *
 * Auth: Firebase bearer token.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  compileEvidencePackage,
  formatEvidencePackageAsText,
} from "@/lib/legal/evidence-compiler";
import { requireAuthenticatedUser } from "@/lib/security/require-authenticated-user";
import { assertOwnership } from "@/lib/security/assert-ownership";
import { userScoped } from "@/lib/security/user-scoped";

export async function GET(req: NextRequest) {
  // B9-1 — Firebase bearer token → users row via the canonical helper. Returns
  // null on missing/invalid token OR unknown user (both → 401).
  const user = await requireAuthenticatedUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const claimId = req.nextUrl.searchParams.get("claimId");
  const disputeId = req.nextUrl.searchParams.get("disputeId") || undefined;
  const format = (req.nextUrl.searchParams.get("format") || "text").toLowerCase();

  if (!claimId) {
    return NextResponse.json({ error: "claimId required" }, { status: 400 });
  }

  const supabase = createServerClient();

  // S305 (Andrew) — the Pro gate is OFF. The Case File is what we hand someone
  // when their case has just died and they may leave us; gating the handoff
  // behind a subscription was a business call, and it is reversed for now.
  // Same posture as the S299 escalation-wall removal: the machinery
  // (FEATURE_ACCESS.documentationAggregation, loadServerSubscription) is left
  // intact, so re-gating later is re-adding a check rather than rebuilding one.
  // Auth and IDOR are untouched — this opens the feature, never the resource.

  // B9-F02 — claimId is attacker-controlled (query param); the compiler reads
  // claim_discrepancies + claim_line_items by claim_id only (service-role bypasses
  // RLS). Verify ownership at the trust boundary before any compile work.
  const ownedClaim = await assertOwnership(supabase, "claims", claimId, user.id);
  if (!ownedClaim) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // If a disputeId is provided, pull the persisted letter body so Section 0
  // can embed it verbatim.
  let letterContent: string | null = null;
  let pinnedInsurancePlanId: string | null = null;
  if (disputeId) {
    const { data: dispute } = await userScoped(supabase, user.id)
      .table("dispute_outcomes")
      .select("letter_content, insurance_plan_id")
      .eq("id", disputeId)
      .maybeSingle();
    if (!dispute) {
      // B9-F03 — a provided disputeId must belong to the token user; the
      // compiler's Section 7 reads dispute_outcomes by id only. Reject foreign ids.
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    letterContent = dispute.letter_content ?? null;
    pinnedInsurancePlanId = (dispute.insurance_plan_id as string | null) ?? null;
  }

  const pkg = await compileEvidencePackage(supabase, {
    claimId,
    userId: user.id,
    disputeId,
    letterContent,
    pinnedInsurancePlanId,
  });

  if (format === "pdf") {
    // Dynamic import — @react-pdf/renderer is heavy and should stay off the
    // cold-start path for text exports.
    const [{ renderToBuffer }, { CaseFilePdf }] = await Promise.all([
      import("@react-pdf/renderer"),
      import("@/lib/legal/case-file-pdf"),
    ]);
    const providerName = pkg.evidence?.claims?.[0]?.providerName ?? null;
    const element = CaseFilePdf({ pkg, providerName, referenceId: claimId.slice(0, 8) });
    const composed = await renderToBuffer(element);

    // S305 (spec §5 decision 4) — bind the user's own uploaded bill/EOB in after
    // the composed pages, under the exhibit label the document's own list
    // printed. PDF only: the text edition can name a file but not contain it,
    // which its exhibit line says rather than implying otherwise.
    const { appendOriginals } = await import("@/lib/legal/attach-originals");
    const { bytes: buffer, failed } = await appendOriginals(
      new Uint8Array(composed),
      pkg.originals ?? [],
      async (storagePath) => {
        const { data, error } = await supabase.storage.from("documents").download(storagePath);
        if (error || !data) return null;
        return await data.arrayBuffer();
      },
    );
    if (failed.length > 0) {
      // Named, never silent — the package itself already carries a page saying
      // so; this is the operational signal that storage is losing documents.
      console.warn("[legal/evidence-package] originals not attached", {
        claimId,
        failed: failed.map((f) => `${f.label}:${f.reason}`),
      });
    }
    const filename = `candid-case-file-${(providerName ?? "claim").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${claimId.slice(0, 8)}.pdf`;
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  const text = formatEvidencePackageAsText(pkg);
  return new NextResponse(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="evidence-package-${claimId.slice(0, 8)}.txt"`,
    },
  });
}
