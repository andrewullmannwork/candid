/**
 * GET /api/admin/dfy/engagements/[engagementId]/submission-packet — the whole
 * envelope as ONE printable PDF (S331).
 *
 * An operator has to print this and mail it. Three separate downloads (a .txt
 * letter and two PDFs) is not a thing you can put in an envelope in one motion,
 * so this assembles exactly the envelope manifest — the appeal letter, then
 * each signed plan-facing instrument, in that order — into a single document.
 *
 * Built on what exists: the manifest comes from `dfyEnvelopeItems`, the letter
 * page from `@react-pdf/renderer`, and the merge from `pdf-lib` (both already
 * dependencies, both already used by the packet builder and the instrument
 * routes). The instrument PDFs are the member's OWN stored files, copied page
 * for page — never re-rendered, so what the plan receives is the artifact the
 * member actually signed.
 *
 * NOT stored as a document: this is a convenience rendering of files that
 * already exist, not a new legal artifact. `buildPacket` is the thing that
 * creates one of those, and duplicating it here would put a second "assembled
 * submission" in the member's file with no signature behind it.
 *
 * Authority: `requireOperator` + `operatorScoped`, the same gate as the acts.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOperator } from "@/lib/admin/require-operator";
import { operatorScoped } from "@/lib/security/operator-scoped";
import { operatorErrorResponse } from "@/lib/dfy/operator-action";
import { loadInsurerLetter, loadSubmittablePaper } from "@/lib/dfy/matter";
import { dfyEnvelopeItems, type DfyInstrumentType } from "@/lib/dfy/paper";
import { contentDisposition } from "@/lib/http/content-disposition";

export async function GET(req: NextRequest, { params }: { params: Promise<{ engagementId: string }> }) {
  const { engagementId } = await params;
  const auth = await requireOperator(req);
  if (!auth.ok) return auth.response;
  const { supabase, operatorUserId } = auth;

  try {
    const scope = await operatorScoped(supabase, operatorUserId, engagementId);
    const e = scope.engagement;

    const [letter, paper] = await Promise.all([
      loadInsurerLetter(supabase, e.user_id, e.claim_id),
      loadSubmittablePaper(supabase, e.user_id, e.consent_event_ids ?? {}),
    ]);
    if (!letter?.letterContent) {
      return NextResponse.json({ error: "No appeal letter on this matter yet", code: "no_letter" }, { status: 409 });
    }

    // The SAME manifest the screen shows, so the printed packet and the panel
    // can never list different things.
    const manifest = dfyEnvelopeItems({
      letterType: letter.letterType,
      signedPlanFacing: paper.map((d) => d.type as DfyInstrumentType),
    });

    const [{ renderToBuffer }, { AppealLetterPdf }, React, { PDFDocument }] = await Promise.all([
      import("@react-pdf/renderer"),
      import("@/lib/dfy/appeal-letter-pdf"),
      import("react"),
      import("pdf-lib"),
    ]);

    const letterBuf = await renderToBuffer(
      React.createElement(AppealLetterPdf, {
        text: letter.letterContent,
        title: "Appeal of Adverse Benefit Determination",
      }) as never,
    );

    const merged = await PDFDocument.create();
    merged.setTitle("Appeal submission packet");
    merged.setProducer("Candid");

    const appendPdf = async (bytes: Uint8Array) => {
      const src = await PDFDocument.load(bytes);
      const pages = await merged.copyPages(src, src.getPageIndices());
      for (const p of pages) merged.addPage(p);
    };

    await appendPdf(new Uint8Array(letterBuf));

    const missing: string[] = [];
    for (const item of manifest) {
      if (item.kind !== "instrument") continue;
      const file = paper.find((d) => d.type === item.key);
      if (!file?.storagePath) {
        // Reported, never silently dropped — a short envelope must not be a
        // surprise at the post office.
        missing.push(item.key);
        continue;
      }
      const { data, error } = await supabase.storage.from("documents").download(file.storagePath);
      if (error || !data) {
        missing.push(item.key);
        continue;
      }
      try {
        await appendPdf(new Uint8Array(await data.arrayBuffer()));
      } catch {
        missing.push(item.key);
      }
    }

    const out = await merged.save();
    const fileName = `Appeal submission packet — ${e.id.slice(0, 8)}.pdf`;
    return new NextResponse(new Uint8Array(out), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": contentDisposition(fileName),
        // The operator must know if something could not be included rather than
        // discovering a short envelope at the post office.
        "X-Packet-Missing": missing.join(",") || "none",
      },
    });
  } catch (err) {
    // A packet failure must name itself: this route assembles four moving
    // parts (letter load, render, storage reads, merge) and "Couldn't build
    // the packet" alone sends the next person hunting.
    console.error("[dfy submission-packet] build failed:", err);
    const { status, body } = operatorErrorResponse(err);
    return NextResponse.json(
      { ...body, detail: err instanceof Error ? err.message : String(err) },
      { status },
    );
  }
}
