"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

// ── response shapes (mirror src/lib/parser/id-block/inventory.ts) ─────────────
type TrustTier = "unverified" | "email_only" | "phone_only" | "phone_email";
type AdminAction = "confirm" | "clear" | "hold";
interface ActionResult {
  ok: boolean;
  message: string;
}

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

function ClusterCard({
  c,
  anchor,
  onAction,
}: {
  c: Cluster;
  anchor: boolean;
  onAction: (id: string, action: AdminAction) => Promise<ActionResult>;
}) {
  const [open, setOpen] = useState(false);
  const [acting, setActing] = useState<AdminAction | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const live = c.state === "shadow" || c.state === "held";

  const doAction = async (action: AdminAction) => {
    if (action === "confirm" || action === "clear") {
      const verb = action === "confirm" ? "Confirm" : "Clear";
      const prompt =
        c.state === "held"
          ? `${verb} will RE-APPLY the withheld promotion to canonical ${short(c.canonicalPlanId)} (${c.documentType}) via the CF-40 mechanism. Proceed?`
          : `${verb} this already-promoted cluster? (disposition only — nothing is re-applied)`;
      if (!window.confirm(prompt)) return;
    }
    setActing(action);
    setActionMsg(null);
    const r = await onAction(c.quarantineId, action);
    setActionMsg(r.message);
    setActing(null);
  };

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

      {/* §4.3 per-cluster actions (PR3b) — only on LIVE (shadow|held) rows. */}
      {live && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3">
          <span className="text-[11px] uppercase tracking-wide text-gray-400">actions</span>
          <button
            disabled={acting !== null}
            onClick={() => void doAction("confirm")}
            className="rounded bg-green-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-50"
            title="Cluster is legitimate → promote (re-applies a held promotion)"
          >
            {acting === "confirm" ? "…" : "Confirm (real → promote)"}
          </button>
          <button
            disabled={acting !== null}
            onClick={() => void doAction("clear")}
            className="rounded bg-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-300 disabled:opacity-50"
            title="Flag was benign → clear (re-applies a held promotion)"
          >
            {acting === "clear" ? "…" : "Clear flag"}
          </button>
          <button
            disabled={acting !== null}
            onClick={() => void doAction("hold")}
            className="rounded bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
            title="Not yet — keep withheld + re-evaluate later"
          >
            {acting === "hold" ? "…" : "Hold"}
          </button>
          {c.state === "held" && (
            <span className="text-[11px] text-amber-700">
              held → Confirm/Clear re-applies the withheld promotion
            </span>
          )}
          {actionMsg && <span className="text-xs text-gray-600">{actionMsg}</span>}
        </div>
      )}

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

// ── §5 inline config editor (PR3b-2) ─────────────────────────────────────────
interface IdBlockCfgShape {
  weights: { high: number; medium: number; low: number };
  normCaps: { accountAgeDaysCap: number; signupLatencyDaysCap: number; activityBreadthCap: number };
  shape: { thinScore: number; burstWindowHours: number; signupCorrelationWindowHours: number };
  gate: { clusterLegitimacyThreshold: number; hammingNearDupThreshold: number; sameContentMajority: number; mode: "shadow" | "active" };
  slack: { enabled: boolean };
}

function CfgNum({ label, value, onChange, step }: { label: string; value: number; onChange: (n: number) => void; step?: string }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-gray-400">{label}</span>
      <input
        type="number"
        step={step ?? "any"}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
        className="rounded border border-gray-300 px-2 py-1 text-sm"
      />
    </label>
  );
}

function ConfigEditor({ token }: { token: () => Promise<string> }) {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<IdBlockCfgShape | null>(null);
  const [flagEnabled, setFlagEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; lines: string[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      const t = await token();
      const res = await fetch("/api/admin/promotion-quarantine/config", { headers: { Authorization: `Bearer ${t}` } });
      const j = await res.json();
      if (!res.ok) { setMsg({ kind: "err", lines: [j.error ?? `HTTP ${res.status}`] }); return; }
      setCfg(j.config as IdBlockCfgShape);
      setFlagEnabled(j.flagEnabled === true);
    } catch (e) {
      setMsg({ kind: "err", lines: [e instanceof Error ? e.message : String(e)] });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { if (open && !cfg) void load(); }, [open, cfg, load]);

  const upd = (grp: keyof IdBlockCfgShape, key: string, val: number | boolean | string) =>
    setCfg((c) => (c ? ({ ...c, [grp]: { ...(c[grp] as object), [key]: val } } as IdBlockCfgShape) : c));

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    setMsg(null);
    try {
      const t = await token();
      const res = await fetch("/api/admin/promotion-quarantine/config", {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({ config: cfg }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg({ kind: "err", lines: (j.errors as string[]) ?? [j.error ?? `HTTP ${res.status}`] }); return; }
      setCfg(j.config as IdBlockCfgShape); // effective parsed config (catches silent coercion)
      setMsg({ kind: "ok", lines: ["Saved.", ...(((j.warnings as string[]) ?? []).map((w) => `⚠ ${w}`))] });
    } catch (e) {
      setMsg({ kind: "err", lines: [e instanceof Error ? e.message : String(e)] });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between px-3 py-2 text-sm font-semibold text-gray-700">
        <span>Gate config (§5) — weights · caps · shape · thresholds · mode</span>
        <span className="text-indigo-600">{open ? "Hide" : "Edit"}</span>
      </button>
      {open && (
        <div className="border-t border-gray-200 p-3">
          {loading && <div className="text-sm text-gray-500">Loading…</div>}
          {cfg && (
            <>
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
                <CfgNum label="weight high" value={cfg.weights.high} onChange={(n) => upd("weights", "high", n)} />
                <CfgNum label="weight medium" value={cfg.weights.medium} onChange={(n) => upd("weights", "medium", n)} />
                <CfgNum label="weight low" value={cfg.weights.low} onChange={(n) => upd("weights", "low", n)} />
                <CfgNum label="cap: account age (d)" value={cfg.normCaps.accountAgeDaysCap} onChange={(n) => upd("normCaps", "accountAgeDaysCap", n)} />
                <CfgNum label="cap: signup→upload (d)" value={cfg.normCaps.signupLatencyDaysCap} onChange={(n) => upd("normCaps", "signupLatencyDaysCap", n)} />
                <CfgNum label="cap: activity breadth" value={cfg.normCaps.activityBreadthCap} onChange={(n) => upd("normCaps", "activityBreadthCap", n)} />
                <CfgNum label="shape: thin score [0–1]" value={cfg.shape.thinScore} onChange={(n) => upd("shape", "thinScore", n)} />
                <CfgNum label="shape: burst window (h)" value={cfg.shape.burstWindowHours} onChange={(n) => upd("shape", "burstWindowHours", n)} />
                <CfgNum label="shape: signup-corr window (h)" value={cfg.shape.signupCorrelationWindowHours} onChange={(n) => upd("shape", "signupCorrelationWindowHours", n)} />
                <CfgNum label="gate: legitimacy threshold [0–1]" value={cfg.gate.clusterLegitimacyThreshold} onChange={(n) => upd("gate", "clusterLegitimacyThreshold", n)} />
                <CfgNum label="gate: Hamming near-dup (≤, 0–64)" value={cfg.gate.hammingNearDupThreshold} onChange={(n) => upd("gate", "hammingNearDupThreshold", n)} step="1" />
                <CfgNum label="gate: same-content majority (0–1]" value={cfg.gate.sameContentMajority} onChange={(n) => upd("gate", "sameContentMajority", n)} />
                <label className="flex flex-col gap-0.5">
                  <span className="text-[11px] uppercase tracking-wide text-gray-400">gate: mode</span>
                  <select value={cfg.gate.mode} onChange={(e) => upd("gate", "mode", e.target.value)} className="rounded border border-gray-300 px-2 py-1 text-sm">
                    <option value="shadow">shadow (log/Slack, hold nothing)</option>
                    <option value="active">active (withhold flagged promotions)</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 self-end">
                  <input type="checkbox" checked={cfg.slack.enabled} onChange={(e) => upd("slack", "enabled", e.target.checked)} />
                  <span className="text-sm text-gray-700">Slack alerts</span>
                </label>
              </div>
              {cfg.gate.mode === "active" && (
                <div className="mt-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                  ⚠ active mode WITHHOLDS flagged promotions. Only switch once the shadow flag-rate is calibrated.
                </div>
              )}
              <div className="mt-3 flex items-center gap-2">
                <button onClick={() => void save()} disabled={saving} className="rounded bg-indigo-600 px-3 py-1 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
                  {saving ? "Saving…" : "Save config"}
                </button>
                <button onClick={() => void load()} disabled={loading || saving} className="text-sm text-gray-600 hover:underline">
                  Reload
                </button>
                {!flagEnabled && <span className="text-[11px] text-gray-400">(flag OFF — gate inert; config still saved)</span>}
              </div>
              {msg && (
                <ul className={`mt-2 rounded p-2 text-xs ${msg.kind === "ok" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                  {msg.lines.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              )}
            </>
          )}
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

  const act = useCallback(
    async (id: string, action: AdminAction): Promise<ActionResult> => {
      try {
        const t = await token();
        const res = await fetch(`/api/admin/promotion-quarantine`, {
          method: "POST",
          headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
          body: JSON.stringify({ id, action }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          deferred?: boolean;
          error?: string;
          message?: string;
          reapply?: { applied: boolean; reason: string } | null;
        };
        if (!res.ok) return { ok: false, message: json.error ?? `HTTP ${res.status}` };
        if (json.deferred) return { ok: false, message: json.message ?? "deferred (Layer-4 adjudication)" };
        await load(); // reflect the new state (disposed rows drop from the live scope)
        const ra = json.reapply;
        const msg = ra
          ? `${action} ✓ — ${ra.applied ? "promotion applied" : `not applied: ${ra.reason}`}`
          : `${action} ✓`;
        return { ok: true, message: msg };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    [token, load],
  );

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
        Corroboration source-independence work-list (anti-Sybil/replay). Per-cluster
        Confirm/Clear/Hold below (§4.3); gate config editor below (§5); the daily re-eval
        cron lands in PR3c.
      </p>

      <ConfigEditor token={token} />

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
          <ClusterCard
            key={c.quarantineId}
            c={c}
            anchor={anchoredIds.has(c.quarantineId)}
            onAction={act}
          />
        ))}
      </div>
    </div>
  );
}
