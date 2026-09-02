/**
 * packet — the state-level filing packet the MEMBER signs and files (S330,
 * Gate 4: "Candid prepares the finished packet; the member signs and submits
 * it"). Built on the EXISTING Case File compiler + PDF: the same sections
 * (letter, chronology, the bill, coverage, exhibits), with ONE cover section
 * prepended — the forum the member chose from the routed menu, where and how
 * to file, the deadline and prerequisite the agency itself states, and the
 * "person assisting" disclosure for the state's form. Stored as a
 * member-owned document like every other DFY artifact.
 */
import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped } from "@/lib/security/user-scoped";
import type { DfyEngagementRow } from "@/lib/security/operator-scoped";
import { compileEvidencePackage, sec, type EvidencePackage } from "@/lib/legal/evidence-compiler";
import { ALL_FORUMS, route, type CoverageType, type CaRegulator, type Forum } from "@/lib/disputes/forums";
import { ENTITY_NAME } from "./paper";

/** The forums the member could file with, from the SAME router the rail uses. */
export function packetForumsFor(engagement: DfyEngagementRow): Forum[] {
  const cls = (engagement.plan_classification ?? {}) as { coverageType?: CoverageType; caRegulator?: CaRegulator; waBbpaOptedIn?: boolean };
  if (!cls.coverageType) return [];
  const r = route({
    state: engagement.member_state,
    coverage: cls.coverageType,
    dispute: "insurer_denial" as never,
    caRegulator: cls.caRegulator,
    waSelfFundedOptedIn: cls.waBbpaOptedIn,
  });
  return r.forums;
}

export function coverSectionFor(forum: Forum, operatorName: string, memberName: string) {
  const where = [
    forum.url ? `Online: ${forum.url}` : null,
    forum.phone ? `Phone: ${forum.phone}${forum.tdd ? ` · TDD ${forum.tdd}` : ""}` : null,
    forum.email ? `Email: ${forum.email}` : null,
  ].filter(Boolean) as string[];
  const lines = [
    `Prepared by Candid for ${memberName} to sign and file personally. Candid does not file with a government agency on a member's behalf.`,
    "",
    `Where this goes: ${forum.agency}${forum.unit ? ` — ${forum.unit}` : ""}.`,
    ...where,
    forum.deadline ? `Deadline (in the agency's words): ${forum.deadline}` : "",
    forum.prerequisite ? `Before you file (in the agency's words): ${forum.prerequisite}` : "",
    forum.cost ? `Cost: ${forum.cost}` : "",
    forum.binding ? `Effect: ${forum.binding}` : "",
    forum.cannot.length ? `What this forum cannot do (the agency's own words): ${forum.cannot.join(" ")}` : "",
    "",
    `Person assisting: ${operatorName}, an employee of ${ENTITY_NAME} (the operator of Candid). If the agency's form has a "person assisting" field, that is the name to enter; the signature on the form is yours.`,
    "",
    "What follows is your case file: the appeal you composed and sent, the plan's response, the bill, your coverage terms, and the exhibits. Attach what the agency's form asks for.",
  ];
  return sec("dfy_packet_cover", `Filing packet — ${forum.short}`, lines);
}

export interface BuiltPacket {
  documentId: string;
  storagePath: string;
  fileName: string;
  bytes: number;
  forumId: string;
}

/** Compile → cover → PDF → storage → the member's documents. */
export async function buildPacket(
  supabase: SupabaseClient,
  engagement: DfyEngagementRow,
  forumId: string,
  disputeId: string | null,
  operatorName: string,
  memberName: string,
): Promise<BuiltPacket> {
  const forum = ALL_FORUMS[forumId];
  if (!forum) throw new Error("unknown forum");
  const member = engagement.user_id;
  let letterContent: string | null = null;
  let pinnedInsurancePlanId: string | null = null;
  if (disputeId) {
    const { data } = await userScoped(supabase, member).table("dispute_outcomes").select("letter_content, insurance_plan_id").eq("id", disputeId).eq("claim_id", engagement.claim_id).maybeSingle();
    const d = data as { letter_content?: string | null; insurance_plan_id?: string | null } | null;
    letterContent = d?.letter_content ?? null;
    pinnedInsurancePlanId = d?.insurance_plan_id ?? null;
  }
  const pkg: EvidencePackage = await compileEvidencePackage(supabase, { claimId: engagement.claim_id, userId: member, disputeId: disputeId ?? undefined, letterContent, pinnedInsurancePlanId });
  const cover = coverSectionFor(forum, operatorName, memberName);
  const withCover: EvidencePackage = { ...pkg, title: `Filing packet — ${forum.short} — ${pkg.title}`, sections: cover ? [cover, ...pkg.sections] : pkg.sections };
  const [{ renderToBuffer }, { CaseFilePdf }, React] = await Promise.all([import("@react-pdf/renderer"), import("@/lib/legal/case-file-pdf"), import("react")]);
  const providerName = pkg.evidence?.claims?.[0]?.providerName ?? null;
  const pdf = await renderToBuffer(React.createElement(CaseFilePdf, { pkg: withCover, providerName, referenceId: engagement.id.slice(0, 8) }) as never);
  const storagePath = `${member}/dfy/${engagement.id}/packet-${forum.id}-${Date.now()}.pdf`;
  const { error: upErr } = await supabase.storage.from("documents").upload(storagePath, pdf, { contentType: "application/pdf", upsert: false });
  if (upErr) throw new Error(`storage: ${upErr.message}`);
  const fileName = `Filing packet — ${forum.short}.pdf`;
  const { data: doc, error: docErr } = await userScoped(supabase, member)
    .table("documents")
    .insert({
      storage_path: storagePath,
      file_name: fileName,
      file_size: pdf.byteLength,
      doc_type: "other",
      classified_type: "other",
      // The health-data consent under which the member's documents exist — the packet is built from them.
      consent_event_id: await latestHealthConsentEventId(supabase, member),
      status: "processed",
      file_hash: createHash("sha256").update(pdf).digest("hex"),
      metadata: { dfy: { engagementId: engagement.id, packet: true, forumId: forum.id, disputeId } },
    })
    .select("id")
    .single();
  if (docErr || !doc) throw new Error(`documents: ${docErr?.message ?? "insert failed"}`);
  return { documentId: (doc as { id: string }).id, storagePath, fileName, bytes: pdf.byteLength, forumId: forum.id };
}

async function latestHealthConsentEventId(supabase: SupabaseClient, memberUserId: string): Promise<string> {
  const { data } = await userScoped(supabase, memberUserId)
    .table("consent_events")
    .select("id")
    .eq("consent_type", "health_data_upload")
    .eq("granted", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const id = (data as { id?: string } | null)?.id;
  if (!id) throw new Error("no health-data consent on file");
  return id;
}
