/**
 * ID-Block — read-only §4 admin work-list inventory (PR3a).
 *
 * Assembles the COMPLETE per-cluster + per-user input inventory the admin work-list
 * renders (SoT §4 — "all inputs and data, so the admin can make informed decisions";
 * NOT rolled-up scores only). Pure read path: queries only, writes NOTHING.
 *
 * Drift firewall: the per-user legitimacy SCORE + contributions come from the gate's
 * EXACT functions — gatherEngagement (signals) → scoreUserLegitimacy — so the number
 * the admin sees equals the number the gate computed. The §4.1 RAW display breakdown
 * (broken-out counts, profile-field presence, this-upload doc + artifact sensor) is
 * gathered HERE because the gate never consumes it; it is display context, not a
 * re-derivation of any scored signal.
 *
 * Two decisions are surfaced per cluster:
 *   - STORED  — the decision recorded at flag-time (canonical_promotion_quarantine row).
 *   - LIVE    — gatherAndScoreCluster re-run with the current config (the "would it
 *               still flag now?" preview that the PR3c re-eval cron will act on —
 *               delayed-not-denied). Null when the cluster is no longer re-derivable.
 *
 * Deferred-no-data signals (login / distinct-active-days, compare/benefits-used,
 * signup→first-action where unavailable, anomaly) are returned as explicit `null` /
 * `deferred` markers — never fabricated (§9.1 discipline).
 *
 * SoT: plans/id-block-corroboration-source-independence.md §4 + §9.1.
 */

import type { createServerClient } from "@/lib/supabase/server";
import { gatherEngagement, gatherAndScoreCluster } from "./gate";
import { scoreUserLegitimacy } from "./cluster-legitimacy";
import type { IdBlockConfig } from "./config";

type SupabaseClient = ReturnType<typeof createServerClient>;
type Row = Record<string, unknown>;
const rowsOf = (d: Row[] | null | undefined): Row[] => d ?? [];

export type TrustTier = "unverified" | "email_only" | "phone_only" | "phone_email";

/** The eight profile-completeness fields (§4.1 "which key fields present/missing"). */
const PROFILE_FIELD_LABELS = [
  "display_name",
  "employer_name",
  "date_of_birth",
  "state",
  "address",
  "county",
  "sex",
  "dependents",
] as const;

/** Artifact-sensor summary on a member's this-upload document (G.2/3 scorer output). */
export interface ThisUploadSensor {
  score: number;
  flagged: boolean;
  assessable: boolean;
  reasons: { code: string; weight: number; detail: string }[];
}

/** A quarantine row as read from canonical_promotion_quarantine (mig 158). */
export interface QuarantineDbRow {
  id: string;
  canonical_plan_id: string;
  document_type: string;
  value_tuple_key: string;
  value_tuple_jsonb: Record<string, unknown>;
  cluster_user_ids: string[];
  content_fingerprints: string[];
  cluster_score: number;
  same_content: boolean;
  novel_canonical: boolean;
  shape_jsonb: Record<string, unknown>;
  trigger_reasons: unknown;
  scale_tier: string;
  state: "shadow" | "held" | "cleared" | "promoted";
  next_eval_at: string | null;
  admin_decision: string | null;
  admin_decided_at: string | null;
  admin_decided_by: string | null;
  created_at: string;
  updated_at: string | null;
}

// ── §4.1 per corroborating user ──────────────────────────────────────────────

export interface PerUserInventory {
  userId: string;
  // identity / verification
  trustTier: TrustTier;
  emailVerified: boolean;
  phoneVerified: boolean;
  isAdmin: boolean;
  // account provenance
  createdAt: string | null;
  accountAgeDays: number;
  signupToUploadLatencyDays: number;
  /** signup → first-ever action across docs/plans/claims/disputes; null if no action seen. */
  signupToFirstActionLatencyDays: number | null;
  // profile
  profileCompleteness: number;
  profileFields: { field: string; present: boolean }[];
  lastProfileEditAt: string | null;
  // activity breadth (RAW components — richer than the scored activity_breadth signal)
  numCards: number;
  numClaims: number;
  numDisputes: number;
  numPlans: number;
  numDistinctDocTypes: number;
  numTotalDocuments: number;
  /** DEFERRED — no compare/benefits event log (§9.1). */
  compareBenefitsUsed: null;
  // costly artifacts (high-weight)
  subscriptionStatus: string | null;
  hasActiveSubscription: boolean;
  hasClaimsWithEob: boolean;
  hasInsuranceCard: boolean;
  /** DEFERRED — no Supabase session/login table (auth is Firebase) (§9.1). */
  engagementDepth: null;
  // this upload
  thisUpload: {
    documentId: string | null;
    fileHash: string | null;
    contentFingerprint: string | null;
    uploadedAt: string | null;
    sensor: ThisUploadSensor | null;
  } | null;
  // per-user legitimacy — from the gate's EXACT scorer (drift firewall)
  legitimacyScore: number;
  bands: { high: number; medium: number; low: number };
  contributions: Record<string, number>;
}

// ── §4.2 cluster aggregate ───────────────────────────────────────────────────

export interface ClusterInventory {
  quarantineId: string;
  canonicalPlanId: string;
  documentType: string;
  valueTuple: Record<string, unknown>;
  novelCanonical: boolean;
  scaleTier: string;
  contentFingerprints: string[];
  members: PerUserInventory[];
  // legitimacy distribution (recomputed from the live per-user scores)
  legitimacyMin: number;
  legitimacyMedian: number;
  legitimacyMax: number;
  pctBelowBar: number;
  uniformlyThin: boolean;
  // verification mix (counts per trust tier)
  verificationMix: Record<TrustTier, number>;
  // sensor
  numDocsSensorFlagged: number;
  // temporal / shape (as recorded at flag-time)
  shape: Record<string, unknown>;
  // decision — STORED (flag-time)
  storedClusterScore: number;
  sameContent: boolean;
  triggerReasons: string[];
  state: "shadow" | "held" | "cleared" | "promoted";
  threshold: number;
  // decision — LIVE (would it still flag now; the PR3c re-eval preview)
  livePreview: {
    clusterScore: number;
    wouldFlag: boolean;
    sameContentReplay: boolean;
    novelLowLegitimacy: boolean;
    reasons: string[];
  } | null;
  // re-eval (delayed-not-denied) — next_eval_at is set by the PR3c cron, null until then
  nextEvalAt: string | null;
  adminDecision: string | null;
  adminDecidedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface QuarantineInventory {
  clusters: ClusterInventory[];
  config: {
    clusterLegitimacyThreshold: number;
    hammingNearDupThreshold: number;
    mode: "shadow" | "active";
    flagEnabled: boolean;
  };
  /**
   * Shadow-measure summary (§5 / SoT §6 calibration). `byState` is exact; `would_flag`
   * = shadow|held live rows. The precise would-flag RATE needs the in-scope-promotion
   * denominator — surfaced best-effort, null when not cheaply derivable (PR3c/⑤ owns
   * the precise calibration view).
   */
  summary: {
    total: number;
    byState: Record<string, number>;
    wouldFlagLive: number;
  };
}

// ── raw §4.1 gather (display only; NOT a scored-signal re-derivation) ─────────

interface RawUser {
  createdAt: string | null;
  displayName: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  isAdmin: boolean;
  subscriptionStatus: string | null;
  profileFields: { field: string; present: boolean }[];
  profileCompleteness: number;
  lastProfileEditAt: string | null;
  numCards: number;
  numClaims: number;
  numDisputes: number;
  numPlans: number;
  numDistinctDocTypes: number;
  numTotalDocuments: number;
  hasClaimsWithEob: boolean;
  hasInsuranceCard: boolean;
  earliestPlanAt: string | null;
  earliestActionAt: string | null;
}

const dayDiff = (fromIso: string | null, toIso: string | null): number | null => {
  if (!fromIso || !toIso) return null;
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, (to - from) / 86_400_000);
};

const minIso = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
};

async function fetchInventoryRaw(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Map<string, RawUser>> {
  const out = new Map<string, RawUser>();
  if (userIds.length === 0) return out;

  const [usersRes, profsRes, subsRes, docsRes, claimsRes, plansRes, disputesRes] =
    await Promise.all([
      supabase.from("users").select("id, created_at, display_name, email_verified, phone_verified, is_admin").in("id", userIds),
      supabase.from("profiles").select("user_id, date_of_birth, state, address, county, sex, dependents, updated_at").in("user_id", userIds),
      supabase.from("stripe_customers").select("user_id, subscription_status").in("user_id", userIds),
      supabase.from("documents").select("id, user_id, classified_type, created_at").in("user_id", userIds),
      supabase.from("claims").select("user_id, source_document_id, created_at").in("user_id", userIds),
      supabase.from("insurance_plans").select("user_id, created_at, employer_name").in("user_id", userIds),
      supabase.from("dispute_outcomes").select("user_id, created_at").in("user_id", userIds),
    ]);

  const userById = new Map(rowsOf(usersRes.data as Row[]).map((u) => [u.id as string, u]));
  const profByUser = new Map(rowsOf(profsRes.data as Row[]).map((p) => [p.user_id as string, p]));
  const subByUser = new Map(
    rowsOf(subsRes.data as Row[]).map((s) => [s.user_id as string, s.subscription_status as string | null]),
  );

  // documents: counts, distinct types, cards, eob doc-ids, earliest action.
  const docTypesByUser = new Map<string, Set<string>>();
  const docCountByUser = new Map<string, number>();
  const cardCountByUser = new Map<string, number>();
  const eobIdsByUser = new Map<string, Set<string>>();
  const earliestActionByUser = new Map<string, string | null>();
  for (const d of rowsOf(docsRes.data as Row[])) {
    const uid = d.user_id as string;
    const ct = (d.classified_type as string | null) ?? "";
    if (!docTypesByUser.has(uid)) docTypesByUser.set(uid, new Set());
    if (ct) docTypesByUser.get(uid)!.add(ct);
    docCountByUser.set(uid, (docCountByUser.get(uid) ?? 0) + 1);
    if (ct === "insurance_card") cardCountByUser.set(uid, (cardCountByUser.get(uid) ?? 0) + 1);
    if (ct === "eob") {
      if (!eobIdsByUser.has(uid)) eobIdsByUser.set(uid, new Set());
      eobIdsByUser.get(uid)!.add(d.id as string);
    }
    earliestActionByUser.set(uid, minIso(earliestActionByUser.get(uid) ?? null, d.created_at as string | null));
  }

  const claimCountByUser = new Map<string, number>();
  const eobClaimUsers = new Set<string>();
  for (const c of rowsOf(claimsRes.data as Row[])) {
    const uid = c.user_id as string;
    claimCountByUser.set(uid, (claimCountByUser.get(uid) ?? 0) + 1);
    const sid = c.source_document_id as string | null;
    if (sid && eobIdsByUser.get(uid)?.has(sid)) eobClaimUsers.add(uid);
    earliestActionByUser.set(uid, minIso(earliestActionByUser.get(uid) ?? null, c.created_at as string | null));
  }

  const planCountByUser = new Map<string, number>();
  const employerUsers = new Set<string>();
  const earliestPlanByUser = new Map<string, string | null>();
  for (const p of rowsOf(plansRes.data as Row[])) {
    const uid = p.user_id as string;
    planCountByUser.set(uid, (planCountByUser.get(uid) ?? 0) + 1);
    if (p.employer_name) employerUsers.add(uid);
    earliestPlanByUser.set(uid, minIso(earliestPlanByUser.get(uid) ?? null, p.created_at as string | null));
    earliestActionByUser.set(uid, minIso(earliestActionByUser.get(uid) ?? null, p.created_at as string | null));
  }

  const disputeCountByUser = new Map<string, number>();
  for (const d of rowsOf(disputesRes.data as Row[])) {
    const uid = d.user_id as string;
    disputeCountByUser.set(uid, (disputeCountByUser.get(uid) ?? 0) + 1);
    earliestActionByUser.set(uid, minIso(earliestActionByUser.get(uid) ?? null, d.created_at as string | null));
  }

  for (const uid of userIds) {
    const u = userById.get(uid);
    const prof = profByUser.get(uid);
    const presence: Record<string, boolean> = {
      display_name: !!u?.display_name,
      employer_name: employerUsers.has(uid),
      date_of_birth: !!prof?.date_of_birth,
      state: !!prof?.state,
      address: !!prof?.address,
      county: !!prof?.county,
      sex: !!prof?.sex,
      dependents: prof?.dependents !== null && prof?.dependents !== undefined && prof?.dependents !== "",
    };
    const profileFields = PROFILE_FIELD_LABELS.map((f) => ({ field: f, present: presence[f] }));
    const profileCompleteness =
      profileFields.filter((f) => f.present).length / profileFields.length;

    out.set(uid, {
      createdAt: (u?.created_at as string | null) ?? null,
      displayName: (u?.display_name as string | null) ?? null,
      emailVerified: u?.email_verified === true,
      phoneVerified: u?.phone_verified === true,
      isAdmin: u?.is_admin === true,
      subscriptionStatus: subByUser.get(uid) ?? null,
      profileFields,
      profileCompleteness,
      lastProfileEditAt: (prof?.updated_at as string | null) ?? null,
      numCards: cardCountByUser.get(uid) ?? 0,
      numClaims: claimCountByUser.get(uid) ?? 0,
      numDisputes: disputeCountByUser.get(uid) ?? 0,
      numPlans: planCountByUser.get(uid) ?? 0,
      numDistinctDocTypes: docTypesByUser.get(uid)?.size ?? 0,
      numTotalDocuments: docCountByUser.get(uid) ?? 0,
      hasClaimsWithEob: eobClaimUsers.has(uid),
      hasInsuranceCard: (cardCountByUser.get(uid) ?? 0) > 0,
      earliestPlanAt: earliestPlanByUser.get(uid) ?? null,
      earliestActionAt: earliestActionByUser.get(uid) ?? null,
    });
  }
  return out;
}

/** Per-(user, docType) this-upload document with its artifact-sensor summary. */
interface UploadDoc {
  documentId: string;
  fileHash: string | null;
  contentFingerprint: string | null;
  uploadedAt: string | null;
  classifiedType: string | null;
  sensor: ThisUploadSensor | null;
}

async function fetchUploadDocs(
  supabase: SupabaseClient,
  userIds: string[],
  docTypes: string[],
): Promise<Map<string, UploadDoc[]>> {
  const out = new Map<string, UploadDoc[]>();
  if (userIds.length === 0 || docTypes.length === 0) return out;
  const { data } = await supabase
    .from("documents")
    .select("id, user_id, classified_type, file_hash, content_fingerprint, created_at, metadata")
    .in("user_id", userIds)
    .in("classified_type", docTypes);
  for (const d of rowsOf(data as Row[])) {
    const uid = d.user_id as string;
    const meta = d.metadata as { adversarial_pdf_assessment?: ThisUploadSensor } | null;
    const sensor = meta?.adversarial_pdf_assessment ?? null;
    if (!out.has(uid)) out.set(uid, []);
    out.get(uid)!.push({
      documentId: d.id as string,
      fileHash: (d.file_hash as string | null) ?? null,
      contentFingerprint: (d.content_fingerprint as string | null) ?? null,
      uploadedAt: (d.created_at as string | null) ?? null,
      classifiedType: (d.classified_type as string | null) ?? null,
      sensor: sensor
        ? {
            score: sensor.score,
            flagged: sensor.flagged,
            assessable: sensor.assessable,
            reasons: sensor.reasons ?? [],
          }
        : null,
    });
  }
  return out;
}

export const trustTier = (email: boolean, phone: boolean): TrustTier =>
  email && phone ? "phone_email" : phone ? "phone_only" : email ? "email_only" : "unverified";

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** §4.2 legitimacy distribution over a cluster's per-user scores. Pure (G4 fixture). */
export interface ScoreSummary {
  min: number;
  median: number;
  max: number;
  pctBelowBar: number;
  uniformlyThin: boolean;
}
export function summarizeMemberScores(
  scores: number[],
  threshold: number,
  thinScore: number,
): ScoreSummary {
  return {
    min: scores.length ? Math.min(...scores) : 0,
    median: median(scores),
    max: scores.length ? Math.max(...scores) : 0,
    pctBelowBar: scores.length ? scores.filter((s) => s < threshold).length / scores.length : 0,
    uniformlyThin: scores.length > 0 && scores.every((s) => s < thinScore),
  };
}

/** The 4 supermajority identity scalars (mirrors gate.ts IDENTITY_FIELDS). */
const IDENTITY_FIELDS = [
  "in_deductible_individual",
  "in_deductible_family",
  "in_oop_max_individual",
  "in_oop_max_family",
] as const;

export function toBaselineTuple(jsonb: Record<string, unknown>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const f of IDENTITY_FIELDS) {
    const v = jsonb[f];
    out[f] = typeof v === "number" ? v : v === null || v === undefined ? null : Number(v);
  }
  return out;
}

/**
 * Build the full §4 inventory for a set of quarantine rows. Read-only. The per-user
 * legitimacy is scored with the gate's exact signals; a per-row LIVE re-evaluation
 * (gatherAndScoreCluster) previews what the PR3c re-eval cron will conclude.
 */
export async function buildQuarantineInventory(
  supabase: SupabaseClient,
  quarantineRows: QuarantineDbRow[],
  cfg: IdBlockConfig,
  flagEnabled: boolean,
): Promise<QuarantineInventory> {
  const unionUserIds = [...new Set(quarantineRows.flatMap((r) => r.cluster_user_ids ?? []))];
  const docTypes = [...new Set(quarantineRows.map((r) => r.document_type))];

  // Signals from the gate's EXACT function (drift firewall) + raw display + this-upload docs.
  const [signalsByUser, rawByUser, uploadDocsByUser] = await Promise.all([
    gatherEngagement(supabase, unionUserIds),
    fetchInventoryRaw(supabase, unionUserIds),
    fetchUploadDocs(supabase, unionUserIds, docTypes),
  ]);

  const threshold = cfg.gate.clusterLegitimacyThreshold;
  const clusters: ClusterInventory[] = [];

  for (const r of quarantineRows) {
    const fpSet = new Set(r.content_fingerprints ?? []);
    const members: PerUserInventory[] = (r.cluster_user_ids ?? []).map((uid) => {
      const raw = rawByUser.get(uid);
      const signals = signalsByUser.get(uid);
      const scored = signals
        ? scoreUserLegitimacy(signals, cfg)
        : { score: 0, bands: { high: 0, medium: 0, low: 0 }, contributions: {} };

      // this-upload: the member's doc of this docType whose fingerprint is in the cluster
      // (fall back to the most recent matching doc).
      const candidates = (uploadDocsByUser.get(uid) ?? []).filter(
        (d) => d.classifiedType === r.document_type,
      );
      const matched =
        candidates.find((d) => d.contentFingerprint && fpSet.has(d.contentFingerprint)) ??
        candidates.sort((a, b) => (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? ""))[0] ??
        null;

      return {
        userId: uid,
        trustTier: trustTier(raw?.emailVerified ?? false, raw?.phoneVerified ?? false),
        emailVerified: raw?.emailVerified ?? false,
        phoneVerified: raw?.phoneVerified ?? false,
        isAdmin: raw?.isAdmin ?? false,
        createdAt: raw?.createdAt ?? null,
        accountAgeDays: signals?.accountAgeDays ?? 0,
        signupToUploadLatencyDays: signals?.signupToUploadLatencyDays ?? 0,
        signupToFirstActionLatencyDays: dayDiff(raw?.createdAt ?? null, raw?.earliestActionAt ?? null),
        profileCompleteness: raw?.profileCompleteness ?? 0,
        profileFields: raw?.profileFields ?? [],
        lastProfileEditAt: raw?.lastProfileEditAt ?? null,
        numCards: raw?.numCards ?? 0,
        numClaims: raw?.numClaims ?? 0,
        numDisputes: raw?.numDisputes ?? 0,
        numPlans: raw?.numPlans ?? 0,
        numDistinctDocTypes: raw?.numDistinctDocTypes ?? 0,
        numTotalDocuments: raw?.numTotalDocuments ?? 0,
        compareBenefitsUsed: null,
        subscriptionStatus: raw?.subscriptionStatus ?? null,
        hasActiveSubscription: signals?.hasActiveSubscription ?? false,
        hasClaimsWithEob: raw?.hasClaimsWithEob ?? false,
        hasInsuranceCard: raw?.hasInsuranceCard ?? false,
        engagementDepth: null,
        thisUpload: matched
          ? {
              documentId: matched.documentId,
              fileHash: matched.fileHash,
              contentFingerprint: matched.contentFingerprint,
              uploadedAt: matched.uploadedAt,
              sensor: matched.sensor,
            }
          : null,
        legitimacyScore: scored.score,
        bands: scored.bands,
        contributions: scored.contributions,
      };
    });

    const scores = members.map((m) => m.legitimacyScore);
    const dist = summarizeMemberScores(scores, threshold, cfg.shape.thinScore);
    const verificationMix: Record<TrustTier, number> = {
      unverified: 0,
      email_only: 0,
      phone_only: 0,
      phone_email: 0,
    };
    for (const m of members) verificationMix[m.trustTier] += 1;
    const numDocsSensorFlagged = members.filter((m) => m.thisUpload?.sensor?.flagged).length;

    // LIVE preview — re-derive + re-score with the current config (the PR3c re-eval).
    let livePreview: ClusterInventory["livePreview"] = null;
    try {
      const live = await gatherAndScoreCluster(
        supabase,
        {
          canonicalPlanId: r.canonical_plan_id,
          docType: r.document_type,
          baselineTuple: toBaselineTuple(r.value_tuple_jsonb ?? {}),
          scaleTier: r.scale_tier,
        },
        cfg,
      );
      if (live) {
        livePreview = {
          clusterScore: live.result.clusterScore,
          wouldFlag: live.result.wouldFlag,
          sameContentReplay: live.result.sameContentReplay,
          novelLowLegitimacy: live.result.novelLowLegitimacy,
          reasons: live.result.reasons,
        };
      }
    } catch {
      livePreview = null;
    }

    const triggerReasons = Array.isArray(r.trigger_reasons)
      ? (r.trigger_reasons as string[])
      : [];

    clusters.push({
      quarantineId: r.id,
      canonicalPlanId: r.canonical_plan_id,
      documentType: r.document_type,
      valueTuple: r.value_tuple_jsonb ?? {},
      novelCanonical: r.novel_canonical,
      scaleTier: r.scale_tier,
      contentFingerprints: r.content_fingerprints ?? [],
      members,
      legitimacyMin: dist.min,
      legitimacyMedian: dist.median,
      legitimacyMax: dist.max,
      pctBelowBar: dist.pctBelowBar,
      uniformlyThin: dist.uniformlyThin,
      verificationMix,
      numDocsSensorFlagged,
      shape: r.shape_jsonb ?? {},
      storedClusterScore: r.cluster_score,
      sameContent: r.same_content,
      triggerReasons,
      state: r.state,
      threshold,
      livePreview,
      nextEvalAt: r.next_eval_at,
      adminDecision: r.admin_decision,
      adminDecidedAt: r.admin_decided_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }

  const byState: Record<string, number> = {};
  for (const r of quarantineRows) byState[r.state] = (byState[r.state] ?? 0) + 1;

  return {
    clusters,
    config: {
      clusterLegitimacyThreshold: threshold,
      hammingNearDupThreshold: cfg.gate.hammingNearDupThreshold,
      mode: cfg.gate.mode,
      flagEnabled,
    },
    summary: {
      total: quarantineRows.length,
      byState,
      wouldFlagLive: clusters.filter((c) => c.livePreview?.wouldFlag).length,
    },
  };
}
