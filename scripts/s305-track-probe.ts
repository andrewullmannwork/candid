/**
 * S305 — READ-ONLY probe: what would `deriveLetterTracks` say about DEV's claims?
 *
 * Answers the two questions step 3 depends on, from the REAL rows rather than
 * from notes:
 *   1. which findings (line-level + claim-level) each claim actually carries,
 *      and what parties the catalog obligates for them;
 *   2. whether the cost-share engine's per-line `insurerDiscrepancy` could fire
 *      — i.e. whether ANY line carries the hard insurer breakdown the engine
 *      requires (member_applied_to_deductible / member_coinsurance / member_copay).
 *
 * (2) is the INGREDIENT check, not the engine: the engine also needs a known
 * deductible/OOP met-status and a plan context. A claim with no breakdown at all
 * can NEVER raise the insurer track; one with a breakdown is a candidate.
 *
 * Usage: npx tsx scripts/s305-track-probe.ts
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { deriveLetterTracks } from "../src/lib/disputes/letter-type";
import { deriveFindingToParties } from "../src/lib/disputes/dispute-ground-catalog";
import { composeRail, letterOfferSkipStepId, type RailLetterOffer } from "../src/lib/case/rail-steps";
import { EMPTY_PROJECTED_REGULATOR } from "../src/lib/case/timeline-projector";
import { loadCaseProjection } from "../src/lib/case/load-case-timeline";

config({ path: ".env.local" });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

type Row = Record<string, unknown>;

async function main() {
  console.log(`DB: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`);

  const { data: claims, error: cErr } = await sb
    .from("claims")
    .select("id, date_of_service, total_billed, metadata, claim_group_id, deleted_at, created_at")
    .order("created_at", { ascending: false });
  if (cErr) throw new Error(`claims: ${cErr.message}`);
  if (!claims) throw new Error("claims: no rows");

  const parties = deriveFindingToParties();

  for (const c of claims as Row[]) {
    const claimId = c.id as string;
    const { data: lines, error: lErr } = await sb
      .from("claim_line_items")
      .select(
        "id, line_number, description, metadata, billed_amount, insurance_paid, patient_owes, member_applied_to_deductible, member_coinsurance, member_copay",
      )
      .eq("claim_id", claimId);
    if (lErr) throw new Error(`lines ${claimId}: ${lErr.message}`);

    const { data: disputes, error: dErr } = await sb
      .from("dispute_outcomes")
      .select("id, dispute_type, status, metadata, sent_at")
      .eq("claim_id", claimId);
    if (dErr) throw new Error(`disputes ${claimId}: ${dErr.message}`);

    const findingTypes: string[] = [];
    let breakdownLines = 0;
    for (const li of (lines ?? []) as Row[]) {
      const meta = (li.metadata ?? {}) as Record<string, unknown>;
      for (const f of (meta.auditFindings ?? []) as Array<Record<string, unknown>>) {
        if (f.dismissed) continue;
        if (!f.actionable) continue;
        findingTypes.push(String(f.type));
      }
      const ins = (meta.insurer ?? meta.eob ?? {}) as Record<string, unknown>;
      const hasBreakdown =
        ins.memberAppliedToDeductible != null ||
        ins.memberCoinsurance != null ||
        ins.memberCopay != null ||
        li.member_applied_to_deductible != null ||
        li.member_coinsurance != null ||
        li.member_copay != null;
      if (hasBreakdown) breakdownLines++;
    }
    const cm = (c.metadata ?? {}) as Record<string, unknown>;
    const audit = (cm.auditSummary ?? {}) as Record<string, unknown>;
    for (const f of (audit.claimLevelFindings ?? []) as Array<Record<string, unknown>>) {
      if (f.dismissed) continue;
      if (!f.actionable) continue;
      findingTypes.push(String(f.type));
    }

    const tracksNoIns = deriveLetterTracks({ findingTypes, insurerUnderpaid: false });
    const tracksWithIns = deriveLetterTracks({ findingTypes, insurerUnderpaid: true });

    const provider =
      ((cm.provider as Record<string, unknown> | undefined)?.name as string | undefined) ?? "?";

    console.log(
      [
        "",
        `── ${claimId.slice(0, 8)} · ${String(c.date_of_service)} · ${provider}${c.deleted_at ? "  [SOFT-DELETED]" : ""}`,
        `   group=${String(c.claim_group_id ?? "").slice(0, 8)}  lines=${lines?.length ?? 0}  breakdownLines=${breakdownLines}`,
        `   findings: ${findingTypes.length ? findingTypes.join(", ") : "(none)"}`,
        `   parties:  ${
          findingTypes
            .map((t) => `${t}→${(parties[t as never] as unknown as string[])?.join("+") ?? "—"}`)
            .join("  ") || "(none)"
        }`,
        `   tracks (insurerUnderpaid=false): ${tracksNoIns.map((t) => `${t.party}/${t.basis}`).join(", ") || "(EMPTY → caller falls back)"}`,
        `   tracks (insurerUnderpaid=true):  ${tracksWithIns.map((t) => `${t.party}/${t.basis}`).join(", ") || "(EMPTY)"}`,
        `   letters:  ${
          (disputes ?? [])
            .map(
              (d) =>
                `${((d.metadata as Record<string, unknown>)?.letterType as string) ?? d.dispute_type}[${d.status}${d.sent_at ? ",sent" : ""}]`,
            )
            .join(", ") || "(none)"
        }`,
      ].join("\n"),
    );
  }
}

/**
 * The RAIL a claim would render, composed by the shipped functions from the
 * shipped projection — the page's own derivation minus React. Proves the rung
 * on real rows rather than on a fixture's hand-built ones.
 */
async function dryRunRail(prefix: string) {
  const { data: claims, error } = await sb
    .from("claims")
    .select("id, user_id, created_at, metadata");
  if (error) throw new Error(`claims: ${error.message}`);
  const claim = (claims ?? []).find((c) => String((c as Row).id).startsWith(prefix)) as Row | undefined;
  if (!claim) throw new Error(`no claim with prefix ${prefix}`);
  const claimId = claim.id as string;
  const userId = claim.user_id as string;

  const { data: lines, error: lErr } = await sb
    .from("claim_line_items")
    .select("id, line_number, metadata, member_applied_to_deductible, member_coinsurance, member_copay")
    .eq("claim_id", claimId);
  if (lErr) throw new Error(`lines: ${lErr.message}`);

  const findingTypes: string[] = [];
  for (const li of (lines ?? []) as Row[]) {
    const meta = (li.metadata ?? {}) as Record<string, unknown>;
    for (const f of (meta.auditFindings ?? []) as Array<Record<string, unknown>>) {
      if (!f.dismissed && f.actionable) findingTypes.push(String(f.type));
    }
  }
  const cm = (claim.metadata ?? {}) as Record<string, unknown>;
  const audit = (cm.auditSummary ?? {}) as Record<string, unknown>;
  const claimFindings = ((audit.claimLevelFindings ?? []) as Array<Record<string, unknown>>).filter(
    (f) => !f.dismissed && f.actionable,
  );
  for (const f of claimFindings) findingTypes.push(String(f.type));

  // ⚠ NOT the cost-share engine — the ingredient it requires. No line carrying a
  // member breakdown means `hasInsurerBreakdown` is false and no discrepancy can
  // ever be built, so this is an upper bound on the insurer signal, not a proxy.
  const anyBreakdown = ((lines ?? []) as Row[]).some(
    (li) =>
      li.member_applied_to_deductible != null ||
      li.member_coinsurance != null ||
      li.member_copay != null,
  );

  const tracks = deriveLetterTracks({ findingTypes, insurerUnderpaid: anyBreakdown });
  const projection = await loadCaseProjection(sb, userId, claimId);
  const letters = projection?.projected.letters ?? [];
  const withLetters = new Set(letters.map((l) => (l.recipientKind === "insurer" ? "insurer" : "provider")));
  const guideSteps = (cm.guideSteps ?? {}) as Record<string, { skippedAt?: string | null }>;

  const offers: RailLetterOffer[] = tracks
    .filter((t) => !withLetters.has(t.party))
    .map((t) => {
      const reason = claimFindings.find((f) =>
        deriveLetterTracks({ findingTypes: [String(f.type)], insurerUnderpaid: false }).some(
          (x) => x.party === t.party,
        ),
      );
      return {
        party: t.party,
        letterType: t.letterType,
        reason: reason
          ? { title: String(reason.title), detail: (reason.description as string | null) ?? null }
          : null,
        declinedAt: guideSteps[letterOfferSkipStepId(t.party)]?.skippedAt ?? null,
      };
    });

  const { groups, resolution } = composeRail({ forumMenu: null,
    letters,
    regulator: projection?.projected.regulator ?? EMPTY_PROJECTED_REGULATOR,
    offers,
    firstNumber: 5,
    insurerNameByDispute: projection?.insurerNameByDispute ?? {},
    providerName: projection?.providerName ?? null,
    now: new Date("2026-08-05T12:00:00Z"),
  });

  console.log(`\n════ DRY-RUN RAIL · claim ${claimId.slice(0, 8)} ════`);
  console.log(`findings: ${findingTypes.join(", ") || "(none)"}`);
  console.log(`insurer breakdown present on any line: ${anyBreakdown}`);
  console.log(`tracks: ${tracks.map((t) => `${t.party}/${t.basis}→${t.letterType}`).join(", ") || "(EMPTY)"}`);
  console.log(`parties already holding a letter: ${[...withLetters].join(", ") || "(none)"}`);
  console.log(`offers composed: ${offers.length}`);
  for (const g of groups) {
    console.log(`\n  ${g.eyebrow}`);
    console.log(`  ${g.title}${g.status ? `   [${g.status.label}]` : "   (no status chip)"}`);
    console.log(`  disputeId=${g.disputeId ?? "null"}  key=${g.key}`);
    for (const s of g.steps) {
      const extra =
        s.kind === "letter-offer"
          ? `  letterType=${s.offer.letterType} declined=${s.offer.declined} stepId=${s.offer.stepId}\n        reason: ${s.offer.reasonTitle ?? "(none)"}`
          : "";
      console.log(`    [${s.badge}] ${s.kind} — ${s.title}${extra ? `\n     ${extra}` : ""}`);
    }
  }
  console.log(`\n  fold: ${resolution ? `${resolution.headline} · ${resolution.meta}` : "(does not fold)"}`);
}

const dryArg = process.argv.indexOf("--rail");
if (dryArg > -1) {
  dryRunRail(process.argv[dryArg + 1] ?? "4e059cb9").catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
