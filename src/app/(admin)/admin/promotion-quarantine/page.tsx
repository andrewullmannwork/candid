"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

// ── response shapes (mirror src/lib/parser/id-block/inventory.ts) ─────────────
type TrustTier = "unverified" | "email_only" | "phone_only" | "phone_email";

interface ThisUploadSensor {
  score: number;
  flagged: boolean;
  assessable: boolean;
  reasons: { code: string; weight: number; detail: string }[];
}
interface PerUser {
  userId: string;
  trustTier: TrustTier;
  emailVerified: boolean;
  phoneVerified: boolean;
  isAdmin: boolean;
  createdAt: string | null;
  accountAgeDays: number;
  signupToUploadLatencyDays: number;
  signupToFirstActionLatencyDays: number | null;
  profileCompleteness: number;
  profileFields: { field: string; present: boolean }[];
  lastProfileEditAt: string | null;
  numCards: number;
  numClaims: number;
  numDisputes: number;
  numPlans: number;
  numDistinctDocTypes: number;
  numTotalDocuments: number;
  compareBenefitsUsed: null;
  subscriptionStatus: string | null;
  hasActiveSubscription: boolean;
  hasClaimsWithEob: boolean;
  hasInsuranceCard: boolean;
  engagementDepth: null;
  thisUpload: {
    documentId: string | null;
    fileHash: string | null;
    contentFingerprint: string | null;
    uploadedAt: string | null;
    sensor: ThisUploadSensor | null;
  } | null;
  legitimacyScore: number;
  bands: { high: number; medium: number; low: number };
  contributions: Record<string, number>;
}
interface Cluster {
  quarantineId: string;
  canonicalPlanId: string;
  documentType: string;
  valueTuple: Record<string, unknown>;
  novelCanonical: boolean;
  scaleTier: string;
  contentFingerprints: string[];
  members: PerUser[];
  legitimacyMin: number;
  legitimacyMedian: number;
  legitimacyMax: number;
  pctBelowBar: number;
  uniformlyThin: boolean;
  verificationMix: Record<TrustTier, number>;
  numDocsSensorFlagged: number;
  shape: Record<string, unknown>;
  storedClusterScore: number;
  sameContent: boolean;
  triggerReasons: string[];
  state: "shadow" | "held" | "cleared" | "promoted";
  threshold: number;
  livePreview: {
    clusterScore: number;
    wouldFlag: boolean;
    sameContentReplay: boolean;
    novelLowLegitimacy: boolean;
    reasons: string[];
  } | null;
  nextEvalAt: string | null;
  adminDecision: string | null;
  adminDecidedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}
interface InventoryResponse {
  clusters: Cluster[];
  config: {
    clusterLegitimacyThreshold: number;
    hammingNearDupThreshold: number;
    mode: "shadow" | "active";
    flagEnabled: boolean;
  };
  summary: { total: number; byState: Record<string, number>; wouldFlagLive: number };
}

// ── formatters ───────────────────────────────────────────────────────────────
const short = (id: string) => `${id.slice(0, 8)}…`;
const fmt = (t: string | null) => (t ? new Date(t).toLocaleString() : "—");
const n3 = (x: number) => x.toFixed(3);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const days = (x: number | null) => (x == null ? "—" : `${Math.round(x)}d`);
const STATE_COLORS: Record<string, string> = {
  shadow: "bg-blue-100 text-blue-700",
  held: "bg-amber-100 text-amber-700",
  cleared: "bg-green-100 text-green-700",
  promoted: "bg-gray-100 text-gray-600",
};
const TIER_LABEL: Record<TrustTier, string> = {
  unverified: "unverified",
  email_only: "email only",
  phone_only: "phone only",
  phone_email: "phone+email",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wide text-gray-400">{label}</span>
      <span className="text-sm text-gray-800">{children}</span>
    </div>
  );
}

function UserCard({ u, threshold }: { u: PerUser; threshold: number }) {
  const below = u.legitimacyScore < threshold;
  const contribs = Object.entries(u.contributions).sort((a, b) => b[1] - a[1]);
  return (
    <div className="rounded border border-gray-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-xs text-gray-600">{short(u.userId)}</span>
        <span
          className={`rounded px-2 py-0.5 text-xs font-semibold ${below ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}
          title="per-user legitimacy (gate's exact scorer)"
        >
          legitimacy {n3(u.legitimacyScore)} {below ? "< bar" : "≥ bar"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Field label="trust tier">{TIER_LABEL[u.trustTier]}</Field>
        <Field label="email / phone">
          {u.emailVerified ? "✓" : "✗"} / {u.phoneVerified ? "✓" : "✗"}
        </Field>
        <Field label="is admin">{u.isAdmin ? "yes" : "no"}</Field>
        <Field label="account age">{days(u.accountAgeDays)}</Field>
        <Field label="created">{fmt(u.createdAt)}</Field>
        <Field label="signup→upload">{days(u.signupToUploadLatencyDays)}</Field>
        <Field label="signup→first action">{days(u.signupToFirstActionLatencyDays)}</Field>
        <Field label="profile complete">{pct(u.profileCompleteness)}</Field>
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {u.profileFields.map((f) => (
          <span
            key={f.field}
            className={`rounded px-1.5 py-0.5 text-[11px] ${f.present ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-400 line-through"}`}
          >
            {f.field}
          </span>
        ))}
        <span className="text-[11px] text-gray-400">· last edit {fmt(u.lastProfileEditAt)}</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Field label="# documents">{u.numTotalDocuments}</Field>
        <Field label="# doc types">{u.numDistinctDocTypes}</Field>
        <Field label="# cards">{u.numCards}</Field>
        <Field label="# claims">{u.numClaims}</Field>
        <Field label="# disputes">{u.numDisputes}</Field>
        <Field label="# plans">{u.numPlans}</Field>
        <Field label="compare/benefits">
          <span className="text-gray-400">deferred (no event log)</span>
        </Field>
        <Field label="engagement depth">
          <span className="text-gray-400">deferred (no session table)</span>
        </Field>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        <Field label="subscription">
          {u.subscriptionStatus ?? "—"} {u.hasActiveSubscription ? "(active)" : ""}
        </Field>
        <Field label="claims w/ EOB">{u.hasClaimsWithEob ? "yes" : "no"}</Field>
        <Field label="insurance card">{u.hasInsuranceCard ? "yes" : "no"}</Field>
      </div>

      <div className="mt-3 rounded bg-gray-50 p-2">
        <div className="text-[11px] uppercase tracking-wide text-gray-400">this upload</div>
        {u.thisUpload ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
            <Field label="document">{u.thisUpload.documentId ? short(u.thisUpload.documentId) : "—"}</Field>
            <Field label="file hash">{u.thisUpload.fileHash ? short(u.thisUpload.fileHash) : "—"}</Field>
            <Field label="fingerprint">{u.thisUpload.contentFingerprint ?? "—"}</Field>
            <Field label="uploaded">{fmt(u.thisUpload.uploadedAt)}</Field>
            <Field label="artifact sensor">
              {u.thisUpload.sensor
                ? `${n3(u.thisUpload.sensor.score)}${u.thisUpload.sensor.flagged ? " · FLAGGED" : ""}`
                : "—"}
            </Field>
          </div>
        ) : (
          <span className="text-sm text-gray-400">no matching document</span>
        )}
      </div>

      <div className="mt-3">
        <div className="text-[11px] uppercase tracking-wide text-gray-400">
          legitimacy contributions (sum = {n3(u.legitimacyScore)})
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {contribs.map(([k, v]) => (
            <span key={k} className="rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] text-indigo-700">
              {k} +{n3(v)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function ClusterCard({ c, anchor }: { c: Cluster; anchor: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      id={anchor ? `canonical-${c.canonicalPlanId}` : undefined}
      className="rounded-lg border border-gray-300 bg-gray-50 p-4 scroll-mt-20"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATE_COLORS[c.state]}`}>
            {c.state}
          </span>
          <span className="font-mono text-sm text-gray-700">canonical {short(c.canonicalPlanId)}</span>
          <span className="text-xs text-gray-500">· {c.documentType} · {c.scaleTier}</span>
          {c.novelCanonical && (
            <span className="rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-700">novel canonical</span>
          )}
          {c.sameContent && (
            <span className="rounded bg-rose-100 px-2 py-0.5 text-xs text-rose-700">same-content</span>
          )}
        </div>
        <span className="text-xs text-gray-400">opened {fmt(c.createdAt)}</span>
      </div>

      {/* decision: stored (flag-time) vs live (re-eval preview) */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded border border-gray-200 bg-white p-3">
          <div className="text-[11px] uppercase tracking-wide text-gray-400">decision — recorded</div>
          <div className="text-sm text-gray-800">
            cluster legitimacy <b>{n3(c.storedClusterScore)}</b> vs bar {n3(c.threshold)}
          </div>
          {c.triggerReasons.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs text-gray-600">
              {c.triggerReasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded border border-gray-200 bg-white p-3">
          <div className="text-[11px] uppercase tracking-wide text-gray-400">
            decision — live now (re-eval preview)
          </div>
          {c.livePreview ? (
            <>
              <div className="text-sm text-gray-800">
                cluster legitimacy <b>{n3(c.livePreview.clusterScore)}</b> vs bar {n3(c.threshold)} →{" "}
                <span className={c.livePreview.wouldFlag ? "text-red-600" : "text-green-600"}>
                  {c.livePreview.wouldFlag ? "would still flag" : "would clear"}
                </span>
              </div>
              {c.livePreview.reasons.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-xs text-gray-600">
                  {c.livePreview.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <span className="text-sm text-gray-400">cluster no longer re-derivable</span>
          )}
        </div>
      </div>

      {/* aggregate */}
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Field label="members">{c.members.length}</Field>
        <Field label="legitimacy min/med/max">
          {n3(c.legitimacyMin)} / {n3(c.legitimacyMedian)} / {n3(c.legitimacyMax)}
        </Field>
        <Field label="% below bar">{pct(c.pctBelowBar)}</Field>
        <Field label="uniformly thin">{c.uniformlyThin ? "yes" : "no"}</Field>
        <Field label="verification mix">
          {(Object.keys(c.verificationMix) as TrustTier[])
            .filter((t) => c.verificationMix[t] > 0)
            .map((t) => `${TIER_LABEL[t]}:${c.verificationMix[t]}`)
            .join(", ") || "—"}
        </Field>
        <Field label="docs sensor-flagged">{c.numDocsSensorFlagged}</Field>
        <Field label="next re-eval">{c.nextEvalAt ? fmt(c.nextEvalAt) : "not scheduled"}</Field>
        <Field label="admin decision">
          {c.adminDecision ? `${c.adminDecision} (${fmt(c.adminDecidedAt)})` : "—"}
        </Field>
      </div>

      <button
        onClick={() => setOpen((v) => !v)}
        className="mt-3 text-sm font-medium text-indigo-600 hover:underline"
      >
        {open ? "Hide" : "Show"} {c.members.length} member{c.members.length === 1 ? "" : "s"} (full §4.1 inventory)
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {c.members.map((u) => (
            <UserCard key={u.userId} u={u} threshold={c.threshold} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function PromotionQuarantinePage() {
  const { user } = useAuth();
  const [scope, setScope] = useState<"live" | "all">("live");
  const [data, setData] = useState<InventoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = useCallback(async () => {
    if (!user) throw new Error("not signed in");
    return user.firebaseUser.getIdToken();
  }, [user]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const t = await token();
      const res = await fetch(`/api/admin/promotion-quarantine?scope=${scope}`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setData((await res.json()) as InventoryResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [scope, token]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  // anchor only the first card per canonical (Slack deep-link → #canonical-<id>).
  const anchoredIds = useMemo(() => {
    const seen = new Set<string>();
    const ids = new Set<string>();
    for (const c of data?.clusters ?? []) {
      if (!seen.has(c.canonicalPlanId)) {
        seen.add(c.canonicalPlanId);
        ids.add(c.quarantineId);
      }
    }
    return ids;
  }, [data]);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Promotion Quarantine — ID-Block</h1>
        <button onClick={() => void load()} className="text-sm text-indigo-600 hover:underline">
          Refresh
        </button>
      </div>
      <p className="mb-4 text-sm text-gray-500">
        Corroboration source-independence work-list (anti-Sybil/replay). Read-only — per-cluster
        Confirm/Clear/Hold + config editing land in PR3b; the daily re-eval cron in PR3c.
      </p>

      {data && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 text-sm">
          <span
            className={`rounded px-2 py-0.5 font-semibold ${data.config.flagEnabled ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}
          >
            flag {data.config.flagEnabled ? `ON · ${data.config.mode}` : "OFF (gate inert)"}
          </span>
          <span className="text-gray-600">legitimacy bar {n3(data.config.clusterLegitimacyThreshold)}</span>
          <span className="text-gray-600">Hamming ≤ {data.config.hammingNearDupThreshold}</span>
          <span className="text-gray-600">
            {data.summary.total} row{data.summary.total === 1 ? "" : "s"} ·{" "}
            {Object.entries(data.summary.byState)
              .map(([s, n]) => `${s}:${n}`)
              .join(" ") || "none"}{" "}
            · would-flag-live {data.summary.wouldFlagLive}
          </span>
          <div className="ml-auto flex gap-1">
            {(["live", "all"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`rounded px-2 py-1 text-xs ${scope === s ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600"}`}
              >
                {s === "live" ? "Live (shadow+held)" : "All (+history)"}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && <div className="text-sm text-gray-500">Loading…</div>}
      {error && <div className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {data && !loading && data.clusters.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          No quarantined promotions. When <code>id_block_corroboration</code> is in shadow and a
          cold_start/small promotion trips the gate, the cluster appears here (and pings Fraud/Spam).
        </div>
      )}

      <div className="space-y-3">
        {(data?.clusters ?? []).map((c) => (
          <ClusterCard key={c.quarantineId} c={c} anchor={anchoredIds.has(c.quarantineId)} />
        ))}
      </div>
    </div>
  );
}
