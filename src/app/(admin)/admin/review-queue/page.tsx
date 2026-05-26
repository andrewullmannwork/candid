"use client";

import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { useAdminQuery } from "@/lib/admin/use-admin-query";

/**
 * /admin/review-queue — Bundle PR #1 / Session 55 (audit item #8 close).
 *
 * Unified Pattern 1 #1 admin review surface for unknown reference data emitted
 * by parsers. Two queues:
 *   1. concept_admin_review_queue (mig 061) — unknown billing codes (CPT/HCPCS/etc.)
 *   2. service_catalog_admin_review_queue (mig 065) — unknown service slugs
 *
 * Workflow per row:
 *   - PROMOTE → admin fills required fields → INSERT target table + UPDATE queue
 *     row (status='promoted', resolved_*_id, reviewed_by_user_id, reviewed_at).
 *     T0.4 reprocess routes the source document via the now-MATCH path.
 *   - REJECT → admin provides reason → UPDATE queue row (status='rejected',
 *     rejection_reason, reviewed_by_user_id, reviewed_at). Source document warning
 *     persists; user can re-upload or contact support.
 *
 * Aggregate signal: count of distinct docs proposing same slug/code helps admin
 * prioritize promotions ("12 users mention this slug" = strong promotion signal).
 */

interface CandidateSuggestion {
  slug: string;
  name: string | null;
  description: string | null;
  concept_id: string | null;
  match_score: number;
  source: "trigram" | "haiku";
}

interface SlugQueueRow {
  id: string;
  source_doc_id: string;
  proposed_by_user_id: string | null;
  parser_source: string;
  proposed_service_slug: string;
  proposed_service_label: string | null;
  proposed_category: string | null;
  source_excerpt: string | null;
  source_excerpt_verified: string | null;
  source_section_hint: string | null;
  context_extract: string | null;
  // Ing-I (S133): 'merged' added when admin folds proposed_slug into an existing
  // canonical as alias via /api/admin/review-queue/merge.
  status: "pending" | "promoted" | "rejected" | "merged";
  resolved_service_slug: string | null;
  rejection_reason: string | null;
  candidate_suggestions: CandidateSuggestion[] | null;
  candidate_suggestions_computed_at: string | null;
  created_at: string;
}

interface ConceptQueueRow {
  id: string;
  source_doc_id: string;
  proposed_by_user_id: string | null;
  proposed_billing_code: string;
  proposed_billing_code_type: "CPT" | "HCPCS" | "NDC" | "REV" | "DRG";
  proposed_concept_label: string | null;
  proposed_service_slug: string | null;
  source_excerpt: string | null;
  source_excerpt_verified: string | null;
  source_section_hint: string | null;
  context_extract: string | null;
  status: "pending" | "promoted" | "rejected";
  resolved_concept_id: string | null;
  rejection_reason: string | null;
  created_at: string;
}

const CATEGORIES = [
  "office_visit", "emergency", "hospital", "imaging", "lab", "rx",
  "therapy", "mental_health", "maternity", "dme", "preventive", "other",
] as const;

type StatusFilter = "all" | "pending" | "promoted" | "rejected" | "merged";

export default function ReviewQueuePage() {
  const { user } = useAuth();
  const { query, update, insert } = useAdminQuery();
  const [slugRows, setSlugRows] = useState<SlugQueueRow[]>([]);
  const [conceptRows, setConceptRows] = useState<ConceptQueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [activeTab, setActiveTab] = useState<"slugs" | "concepts">("slugs");
  const [actionRowId, setActionRowId] = useState<string | null>(null);
  // Ing-I (S133): slug-side actions extend to 'merge' (concept-side unchanged)
  const [actionMode, setActionMode] = useState<"promote" | "reject" | "merge" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    async function load() {
      try {
        const filters: Array<{ column: string; op: string; value: unknown }> = [];
        if (statusFilter !== "all") {
          filters.push({ column: "status", op: "eq", value: statusFilter });
        }
        const [slugData, conceptData] = await Promise.all([
          query({
            table: "service_catalog_admin_review_queue",
            filters,
            order: { column: "created_at", ascending: false },
            limit: 200,
          }),
          query({
            table: "concept_admin_review_queue",
            filters,
            order: { column: "created_at", ascending: false },
            limit: 200,
          }),
        ]);
        setSlugRows((slugData as SlugQueueRow[]) || []);
        setConceptRows((conceptData as ConceptQueueRow[]) || []);
      } catch (err) {
        console.error("Failed to load review queue:", err);
        setError(err instanceof Error ? err.message : String(err));
      }
      setLoading(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, statusFilter]);

  // Aggregate signal: count of distinct source_doc_id per proposed_service_slug.
  // Strong promotion candidates have many docs proposing the same slug.
  const slugSignalCounts = useMemo(() => {
    const counts = new Map<string, Set<string>>();
    for (const r of slugRows) {
      if (r.status !== "pending") continue;
      const set = counts.get(r.proposed_service_slug) ?? new Set();
      set.add(r.source_doc_id);
      counts.set(r.proposed_service_slug, set);
    }
    return new Map(Array.from(counts.entries()).map(([k, v]) => [k, v.size]));
  }, [slugRows]);

  const conceptSignalCounts = useMemo(() => {
    const counts = new Map<string, Set<string>>();
    for (const r of conceptRows) {
      if (r.status !== "pending") continue;
      const key = `${r.proposed_billing_code_type}:${r.proposed_billing_code}`;
      const set = counts.get(key) ?? new Set();
      set.add(r.source_doc_id);
      counts.set(key, set);
    }
    return new Map(Array.from(counts.entries()).map(([k, v]) => [k, v.size]));
  }, [conceptRows]);

  async function reload() {
    setLoading(true);
    const filters: Array<{ column: string; op: string; value: unknown }> = [];
    if (statusFilter !== "all") {
      filters.push({ column: "status", op: "eq", value: statusFilter });
    }
    const [slugData, conceptData] = await Promise.all([
      query({
        table: "service_catalog_admin_review_queue",
        filters,
        order: { column: "created_at", ascending: false },
        limit: 200,
      }),
      query({
        table: "concept_admin_review_queue",
        filters,
        order: { column: "created_at", ascending: false },
        limit: 200,
      }),
    ]);
    setSlugRows((slugData as SlugQueueRow[]) || []);
    setConceptRows((conceptData as ConceptQueueRow[]) || []);
    setLoading(false);
  }

  if (!user) return <div className="p-6">Sign in required</div>;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Admin Review Queue</h1>
      <p className="text-sm text-gray-600 mb-4">
        Pattern 1 #1 admin gate for parser-emitted unknown reference data. Review +
        promote to grow service_catalog (slugs) or concepts (billing codes).
      </p>

      {error && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Status filter + tabs */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm"
        >
          <option value="pending">Pending ({slugRows.filter(r => r.status === "pending").length + conceptRows.filter(r => r.status === "pending").length})</option>
          <option value="promoted">Promoted</option>
          <option value="rejected">Rejected</option>
          <option value="merged">Merged (Ing-I)</option>
          <option value="all">All</option>
        </select>

        <div className="flex border-b border-gray-200">
          <button
            onClick={() => setActiveTab("slugs")}
            className={`px-4 py-2 text-sm font-medium ${
              activeTab === "slugs"
                ? "border-b-2 border-blue-600 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            Service Slugs ({slugRows.length})
          </button>
          <button
            onClick={() => setActiveTab("concepts")}
            className={`px-4 py-2 text-sm font-medium ${
              activeTab === "concepts"
                ? "border-b-2 border-blue-600 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            Billing Codes ({conceptRows.length})
          </button>
        </div>
      </div>

      {loading && <div className="text-sm text-gray-500">Loading...</div>}

      {!loading && activeTab === "slugs" && (
        <SlugTable
          rows={slugRows}
          signalCounts={slugSignalCounts}
          actionRowId={actionRowId}
          actionMode={actionMode}
          onAction={(id, mode) => { setActionRowId(id); setActionMode(mode); setError(null); }}
          onCancel={() => { setActionRowId(null); setActionMode(null); }}
          onMerge={async (row, canonicalSlug) => {
            try {
              if (!user) throw new Error("Not signed in");
              const token = await user.firebaseUser.getIdToken();
              const res = await fetch("/api/admin/review-queue/merge", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ queueId: row.id, canonicalSlug }),
              });
              const result = (await res.json()) as
                | { ok: true; alias_slug: string; canonical_slug: string }
                | { ok: false; error: string; detail?: unknown };
              if (!res.ok || !("ok" in result) || !result.ok) {
                const err = "error" in result ? result.error : `HTTP ${res.status}`;
                throw new Error(`MERGE failed: ${err}`);
              }
              setActionRowId(null);
              setActionMode(null);
              await reload();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
          onLoadCandidates={async (row) => {
            if (!user) throw new Error("Not signed in");
            const token = await user.firebaseUser.getIdToken();
            const res = await fetch("/api/admin/review-queue/candidates", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({ queueId: row.id }),
            });
            if (!res.ok) {
              const body = (await res.json().catch(() => ({}))) as { error?: string };
              throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            const data = (await res.json()) as {
              candidates: CandidateSuggestion[];
              cached: boolean;
            };
            return data.candidates;
          }}
          onPromote={async (row, fields) => {
            try {
              // Insert into service_catalog
              await insert("service_catalog", {
                slug: fields.resolvedSlug,
                name: fields.name,
                category: fields.category,
                description: fields.description || null,
                is_preventive_eligible: fields.isPreventiveEligible,
              });
              // Update queue row
              await update("service_catalog_admin_review_queue", row.id, {
                status: "promoted",
                resolved_service_slug: fields.resolvedSlug,
                // v1: admin UUID not exposed in client auth context. FK column is nullable
                // per mig 061/065 (ON DELETE SET NULL). Fast-follow: derive admin UUID
                // server-side via a dedicated /api/admin/me route or extend useAdminQuery
                // to expose it, then populate reviewed_by_user_id for full audit trail.
                reviewed_by_user_id: null,
                reviewed_at: new Date().toISOString(),
              });
              setActionRowId(null);
              setActionMode(null);
              await reload();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
          onReject={async (row, reason) => {
            try {
              await update("service_catalog_admin_review_queue", row.id, {
                status: "rejected",
                rejection_reason: reason,
                // v1: admin UUID not exposed in client auth context. FK column is nullable
                // per mig 061/065 (ON DELETE SET NULL). Fast-follow: derive admin UUID
                // server-side via a dedicated /api/admin/me route or extend useAdminQuery
                // to expose it, then populate reviewed_by_user_id for full audit trail.
                reviewed_by_user_id: null,
                reviewed_at: new Date().toISOString(),
              });
              setActionRowId(null);
              setActionMode(null);
              await reload();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      )}

      {!loading && activeTab === "concepts" && (
        <ConceptTable
          rows={conceptRows}
          signalCounts={conceptSignalCounts}
          actionRowId={actionRowId}
          // Ing-I (S133): concept-side does NOT support merge; narrow the
          // shared actionMode type. 'merge' on concepts collapses to null
          // (action panel won't open).
          actionMode={actionMode === "merge" ? null : actionMode}
          onAction={(id, mode) => { setActionRowId(id); setActionMode(mode); setError(null); }}
          onCancel={() => { setActionRowId(null); setActionMode(null); }}
          onReject={async (row, reason) => {
            try {
              await update("concept_admin_review_queue", row.id, {
                status: "rejected",
                rejection_reason: reason,
                // v1: admin UUID not exposed in client auth context. FK column is nullable
                // per mig 061/065 (ON DELETE SET NULL). Fast-follow: derive admin UUID
                // server-side via a dedicated /api/admin/me route or extend useAdminQuery
                // to expose it, then populate reviewed_by_user_id for full audit trail.
                reviewed_by_user_id: null,
                reviewed_at: new Date().toISOString(),
              });
              setActionRowId(null);
              setActionMode(null);
              await reload();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      )}
    </div>
  );
}

// ─── Slug Table ─────────────────────────────────────────────────────────────
function SlugTable(props: {
  rows: SlugQueueRow[];
  signalCounts: Map<string, number>;
  actionRowId: string | null;
  actionMode: "promote" | "reject" | "merge" | null;
  onAction: (id: string, mode: "promote" | "reject" | "merge") => void;
  onCancel: () => void;
  onPromote: (row: SlugQueueRow, fields: { resolvedSlug: string; name: string; category: string; description: string; isPreventiveEligible: boolean }) => Promise<void>;
  onReject: (row: SlugQueueRow, reason: string) => Promise<void>;
  onMerge: (row: SlugQueueRow, canonicalSlug: string) => Promise<void>;
  onLoadCandidates: (row: SlugQueueRow) => Promise<CandidateSuggestion[]>;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="border-b border-gray-200 text-left text-xs uppercase text-gray-500">
        <tr>
          <th className="py-2 pr-3">Proposed Slug</th>
          <th className="py-2 pr-3">Parser</th>
          <th className="py-2 pr-3">Signal</th>
          <th className="py-2 pr-3">Source Excerpt</th>
          <th className="py-2 pr-3">Status</th>
          <th className="py-2 pr-3">Created</th>
          <th className="py-2 pr-3">Actions</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => (
          <RowGroup
            key={row.id}
            row={row}
            isActionTarget={props.actionRowId === row.id}
            actionMode={props.actionMode}
            signalCount={props.signalCounts.get(row.proposed_service_slug) ?? 1}
            onAction={(mode) => props.onAction(row.id, mode)}
            onCancel={props.onCancel}
            onPromote={(fields) => props.onPromote(row, fields)}
            onReject={(reason) => props.onReject(row, reason)}
            onMerge={(canonicalSlug) => props.onMerge(row, canonicalSlug)}
            onLoadCandidates={() => props.onLoadCandidates(row)}
          />
        ))}
        {props.rows.length === 0 && (
          <tr><td colSpan={7} className="py-6 text-center text-gray-500">No rows in this view.</td></tr>
        )}
      </tbody>
    </table>
  );
}

function RowGroup(props: {
  row: SlugQueueRow;
  isActionTarget: boolean;
  actionMode: "promote" | "reject" | "merge" | null;
  signalCount: number;
  onAction: (mode: "promote" | "reject" | "merge") => void;
  onCancel: () => void;
  onPromote: (fields: { resolvedSlug: string; name: string; category: string; description: string; isPreventiveEligible: boolean }) => Promise<void>;
  onReject: (reason: string) => Promise<void>;
  onMerge: (canonicalSlug: string) => Promise<void>;
  onLoadCandidates: () => Promise<CandidateSuggestion[]>;
}) {
  const [resolvedSlug, setResolvedSlug] = useState(props.row.proposed_service_slug);
  const [name, setName] = useState(props.row.proposed_service_label ?? "");
  const [category, setCategory] = useState<string>(props.row.proposed_category ?? "other");
  const [description, setDescription] = useState("");
  const [isPreventive, setIsPreventive] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Ing-I (S133): candidate-suggestions state lifted from CandidatePanel to
  // RowGroup so all three action branches (promote / reject / merge) display
  // top-K candidates as context. Read-only display for promote + reject;
  // interactive merge buttons for the merge branch.
  // Initial state seeds from row.candidate_suggestions (cached via backfill);
  // lazy-loads on first action-mode selection if cache miss (post-backfill
  // pending rows have NULL until first read).
  const [candidates, setCandidates] = useState<CandidateSuggestion[] | null>(
    props.row.candidate_suggestions,
  );
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);

  useEffect(() => {
    // Auto-load when admin opens any action panel + cache miss
    if (!props.isActionTarget || !props.actionMode) return;
    if (candidates !== null) return;
    if (candidatesLoading) return;
    setCandidatesLoading(true);
    setCandidatesError(null);
    props
      .onLoadCandidates()
      .then((c) => {
        setCandidates(c);
        setCandidatesLoading(false);
      })
      .catch((err: unknown) => {
        setCandidatesError(err instanceof Error ? err.message : String(err));
        setCandidatesLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.isActionTarget, props.actionMode]);

  return (
    <>
      <tr className="border-b border-gray-100">
        <td className="py-2 pr-3 font-mono text-xs">{props.row.proposed_service_slug}</td>
        <td className="py-2 pr-3 text-xs">{props.row.parser_source}</td>
        <td className="py-2 pr-3 text-xs">
          <span className={`rounded px-2 py-0.5 ${props.signalCount >= 3 ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>
            {props.signalCount} doc{props.signalCount !== 1 ? "s" : ""}
          </span>
        </td>
        <td className="py-2 pr-3 max-w-md truncate text-xs text-gray-600" title={props.row.source_excerpt ?? ""}>
          {props.row.source_excerpt ?? <em className="text-gray-400">(none)</em>}
        </td>
        <td className="py-2 pr-3 text-xs"><StatusBadge status={props.row.status} /></td>
        <td className="py-2 pr-3 text-xs text-gray-500">{new Date(props.row.created_at).toLocaleDateString()}</td>
        <td className="py-2 pr-3 text-xs">
          {props.row.status === "pending" && !props.isActionTarget && (
            <div className="flex flex-wrap gap-1">
              <button onClick={() => props.onAction("promote")} className="rounded bg-green-600 px-2 py-1 text-white hover:bg-green-700">Promote</button>
              <button onClick={() => props.onAction("merge")} className="rounded bg-blue-600 px-2 py-1 text-white hover:bg-blue-700" title="Ing-I: fold this proposed slug into an existing canonical slug as an alias">Merge…</button>
              <button onClick={() => props.onAction("reject")} className="rounded bg-gray-400 px-2 py-1 text-white hover:bg-gray-500">Reject</button>
            </div>
          )}
          {props.row.status === "promoted" && <span className="text-green-700">→ {props.row.resolved_service_slug}</span>}
          {props.row.status === "rejected" && <span className="text-gray-500" title={props.row.rejection_reason ?? ""}>rejected</span>}
          {props.row.status === "merged" && <span className="text-blue-700" title={`Alias of ${props.row.resolved_service_slug}`}>→ merged into {props.row.resolved_service_slug}</span>}
        </td>
      </tr>
      {props.isActionTarget && props.actionMode === "promote" && (
        <tr className="border-b border-gray-100 bg-blue-50">
          <td colSpan={7} className="p-3">
            <CandidateContextBanner
              candidates={candidates}
              loading={candidatesLoading}
              error={candidatesError}
              mode="promote"
            />
            <div className="grid grid-cols-2 gap-3 text-xs">
              <label>Final slug
                <input value={resolvedSlug} onChange={(e) => setResolvedSlug(e.target.value)} className="mt-1 w-full rounded border border-gray-300 px-2 py-1 font-mono" />
              </label>
              <label>Name
                <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded border border-gray-300 px-2 py-1" placeholder="Display name (required)" />
              </label>
              <label>Category
                <select value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 w-full rounded border border-gray-300 px-2 py-1">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label>Description (optional)
                <input value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1 w-full rounded border border-gray-300 px-2 py-1" />
              </label>
              <label className="col-span-2 flex items-center gap-2">
                <input type="checkbox" checked={isPreventive} onChange={(e) => setIsPreventive(e.target.checked)} />
                ACA preventive (covered $0 by mandate)
              </label>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                disabled={submitting || !name.trim() || !resolvedSlug.trim()}
                onClick={async () => {
                  setSubmitting(true);
                  await props.onPromote({ resolvedSlug: resolvedSlug.trim(), name: name.trim(), category, description: description.trim(), isPreventiveEligible: isPreventive });
                  setSubmitting(false);
                }}
                className="rounded bg-green-600 px-3 py-1.5 text-xs text-white hover:bg-green-700 disabled:bg-gray-300"
              >
                {submitting ? "Promoting..." : "Confirm Promote"}
              </button>
              <button onClick={props.onCancel} className="rounded bg-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-400">Cancel</button>
            </div>
          </td>
        </tr>
      )}
      {props.isActionTarget && props.actionMode === "reject" && (
        <tr className="border-b border-gray-100 bg-amber-50">
          <td colSpan={7} className="p-3">
            <CandidateContextBanner
              candidates={candidates}
              loading={candidatesLoading}
              error={candidatesError}
              mode="reject"
            />
            <label className="text-xs">Rejection reason (admin notes)
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-xs" placeholder="Why is this slug not valid? (e.g., 'duplicate of existing slug X', 'fragment of larger phrase', 'malformed')" />
            </label>
            <div className="mt-2 flex gap-2">
              <button
                disabled={submitting || !reason.trim()}
                onClick={async () => {
                  setSubmitting(true);
                  await props.onReject(reason.trim());
                  setSubmitting(false);
                }}
                className="rounded bg-amber-600 px-3 py-1.5 text-xs text-white hover:bg-amber-700 disabled:bg-gray-300"
              >
                {submitting ? "Rejecting..." : "Confirm Reject"}
              </button>
              <button onClick={props.onCancel} className="rounded bg-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-400">Cancel</button>
            </div>
          </td>
        </tr>
      )}
      {props.isActionTarget && props.actionMode === "merge" && (
        <tr className="border-b border-gray-100 bg-blue-50">
          <td colSpan={7} className="p-3">
            <CandidatePanel
              row={props.row}
              candidates={candidates}
              loading={candidatesLoading}
              error={candidatesError}
              onMerge={props.onMerge}
              onCancel={props.onCancel}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Candidate Context Banner (Ing-I S133) — read-only display ────────────
// Used in Promote + Reject action panels to give admin full context BEFORE
// committing to either action. Same candidate data the Merge flow uses, but
// without interactive Merge buttons. Prevents accidental Promote-as-duplicate
// when a strong canonical match exists + prevents accidental Reject of useful
// signal when proposed slug is plausibly aliasable.
function CandidateContextBanner(props: {
  candidates: CandidateSuggestion[] | null;
  loading: boolean;
  error: string | null;
  mode: "promote" | "reject";
}) {
  if (props.error) {
    return (
      <div className="mb-3 rounded border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-800">
        Top candidates failed to load: {props.error}
      </div>
    );
  }
  if (props.loading) {
    return (
      <div className="mb-3 rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-500">
        Loading top candidates...
      </div>
    );
  }
  if (props.candidates === null) return null;

  const bannerHint =
    props.mode === "promote"
      ? "Top canonical candidates this proposed slug may already represent. If any look like the same concept, consider MERGE instead of Promote."
      : "Top canonical candidates this proposed slug may already represent. If any look like the same concept, consider MERGE instead of Reject.";

  if (props.candidates.length === 0) {
    return (
      <div className="mb-3 rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-600">
        No candidate canonicals above threshold — proposed slug is likely genuinely novel or garbage.
      </div>
    );
  }

  return (
    <div className="mb-3 rounded border border-gray-200 bg-white px-2 py-2 text-xs">
      <div className="mb-1.5 text-gray-600">{bannerHint}</div>
      <div className="space-y-1">
        {props.candidates.map((c) => (
          <div
            key={c.slug}
            className="flex items-center gap-3 rounded border border-gray-200 px-2 py-1"
          >
            <div className="flex-1">
              <div className="font-mono text-gray-900">{c.slug}</div>
              {c.name && <div className="text-gray-700">{c.name}</div>}
              {c.description && (
                <div className="truncate text-gray-500" title={c.description}>
                  {c.description}
                </div>
              )}
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <span
                className={`rounded px-1.5 py-0.5 font-semibold ${
                  c.match_score >= 0.8
                    ? "bg-green-100 text-green-800"
                    : c.match_score >= 0.6
                      ? "bg-blue-100 text-blue-800"
                      : "bg-gray-100 text-gray-600"
                }`}
              >
                {c.match_score.toFixed(2)}
              </span>
              <span className="text-[10px] uppercase text-gray-500">
                {c.source}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Candidate Panel (Ing-I S133) ───────────────────────────────────────────
// Interactive variant for the Merge action: same candidate display + per-candidate
// "Merge into" buttons with 2-click confirm.
function CandidatePanel(props: {
  row: SlugQueueRow;
  candidates: CandidateSuggestion[] | null;
  loading: boolean;
  error: string | null;
  onMerge: (canonicalSlug: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [confirmingSlug, setConfirmingSlug] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  const { candidates, loading, error } = props;

  return (
    <div className="text-xs">
      <div className="mb-2 font-medium text-blue-900">
        Merge <span className="font-mono">{props.row.proposed_service_slug}</span> into an existing canonical slug
      </div>
      <div className="mb-2 text-blue-700">
        Pick a candidate below. MERGE creates an alias row in service_catalog
        (canonical_for_concept=FALSE) so future parses of{" "}
        <span className="font-mono">{props.row.proposed_service_slug}</span>{" "}
        resolve to the chosen canonical via concept_id linkage. Existing
        already-parsed documents are NOT affected (admin reprocess required separately).
      </div>
      {loading && <div className="text-gray-500">Loading candidates...</div>}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-2 py-1 text-red-800">
          {error}
        </div>
      )}
      {candidates !== null && candidates.length === 0 && !loading && (
        <div className="rounded border border-gray-300 bg-white px-2 py-2 text-gray-600">
          No matching canonical slugs found above thresholds. If this is genuinely a
          new concept, use <strong>Promote</strong> instead. If it&apos;s a
          fragment / malformed, use <strong>Reject</strong>.
        </div>
      )}
      {candidates !== null && candidates.length > 0 && (
        <div className="space-y-1">
          {candidates.map((c) => (
            <div
              key={c.slug}
              className="flex items-center gap-3 rounded border border-blue-200 bg-white px-2 py-1.5"
            >
              <div className="flex-1">
                <div className="font-mono text-blue-900">{c.slug}</div>
                {c.name && (
                  <div className="text-gray-700">{c.name}</div>
                )}
                {c.description && (
                  <div className="truncate text-gray-500" title={c.description}>
                    {c.description}
                  </div>
                )}
              </div>
              <div className="flex flex-col items-end gap-0.5">
                <span
                  className={`rounded px-1.5 py-0.5 font-semibold ${
                    c.match_score >= 0.8
                      ? "bg-green-100 text-green-800"
                      : c.match_score >= 0.6
                        ? "bg-blue-100 text-blue-800"
                        : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {c.match_score.toFixed(2)}
                </span>
                <span className="text-[10px] uppercase text-gray-500">
                  {c.source}
                </span>
              </div>
              {confirmingSlug === c.slug ? (
                <div className="flex gap-1">
                  <button
                    disabled={merging}
                    onClick={async () => {
                      setMerging(true);
                      await props.onMerge(c.slug);
                      setMerging(false);
                    }}
                    className="rounded bg-blue-600 px-2 py-1 text-white hover:bg-blue-700 disabled:bg-gray-300"
                  >
                    {merging ? "Merging..." : "Confirm Merge"}
                  </button>
                  <button
                    disabled={merging}
                    onClick={() => setConfirmingSlug(null)}
                    className="rounded bg-gray-300 px-2 py-1 text-gray-700 hover:bg-gray-400"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmingSlug(c.slug)}
                  className="rounded bg-blue-600 px-2 py-1 text-white hover:bg-blue-700"
                >
                  Merge into
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="mt-2">
        <button
          onClick={props.onCancel}
          className="rounded bg-gray-300 px-3 py-1 text-gray-700 hover:bg-gray-400"
        >
          Close
        </button>
      </div>
    </div>
  );
}

// ─── Concept Table ──────────────────────────────────────────────────────────
// Promotion intentionally NOT inline: concepts table requires CPT/HCPCS/etc. semantic
// review (vocabulary mapping, label normalization sans CPT licensing copy). For v1 we
// surface "Reject" inline; "Promote" requires SQL or a future concept-creation form.
function ConceptTable(props: {
  rows: ConceptQueueRow[];
  signalCounts: Map<string, number>;
  actionRowId: string | null;
  actionMode: "promote" | "reject" | null;
  onAction: (id: string, mode: "promote" | "reject") => void;
  onCancel: () => void;
  onReject: (row: ConceptQueueRow, reason: string) => Promise<void>;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="border-b border-gray-200 text-left text-xs uppercase text-gray-500">
        <tr>
          <th className="py-2 pr-3">Code</th>
          <th className="py-2 pr-3">Type</th>
          <th className="py-2 pr-3">Signal</th>
          <th className="py-2 pr-3">Label / Excerpt</th>
          <th className="py-2 pr-3">Status</th>
          <th className="py-2 pr-3">Created</th>
          <th className="py-2 pr-3">Actions</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => (
          <ConceptRow
            key={row.id}
            row={row}
            isActionTarget={props.actionRowId === row.id}
            actionMode={props.actionMode}
            signalCount={props.signalCounts.get(`${row.proposed_billing_code_type}:${row.proposed_billing_code}`) ?? 1}
            onAction={(mode) => props.onAction(row.id, mode)}
            onCancel={props.onCancel}
            onReject={(reason) => props.onReject(row, reason)}
          />
        ))}
        {props.rows.length === 0 && (
          <tr><td colSpan={7} className="py-6 text-center text-gray-500">No rows in this view.</td></tr>
        )}
      </tbody>
    </table>
  );
}

function ConceptRow(props: {
  row: ConceptQueueRow;
  isActionTarget: boolean;
  actionMode: "promote" | "reject" | null;
  signalCount: number;
  onAction: (mode: "promote" | "reject") => void;
  onCancel: () => void;
  onReject: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  return (
    <>
      <tr className="border-b border-gray-100">
        <td className="py-2 pr-3 font-mono text-xs">{props.row.proposed_billing_code}</td>
        <td className="py-2 pr-3 text-xs">{props.row.proposed_billing_code_type}</td>
        <td className="py-2 pr-3 text-xs">
          <span className={`rounded px-2 py-0.5 ${props.signalCount >= 3 ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>
            {props.signalCount} doc{props.signalCount !== 1 ? "s" : ""}
          </span>
        </td>
        <td className="py-2 pr-3 max-w-md truncate text-xs text-gray-600" title={props.row.proposed_concept_label ?? props.row.source_excerpt ?? ""}>
          {props.row.proposed_concept_label ?? props.row.source_excerpt ?? <em className="text-gray-400">(none)</em>}
        </td>
        <td className="py-2 pr-3 text-xs"><StatusBadge status={props.row.status} /></td>
        <td className="py-2 pr-3 text-xs text-gray-500">{new Date(props.row.created_at).toLocaleDateString()}</td>
        <td className="py-2 pr-3 text-xs">
          {props.row.status === "pending" && !props.isActionTarget && (
            <div className="flex gap-1">
              <span className="rounded bg-gray-200 px-2 py-1 text-gray-600" title="Promotion requires SQL — use service_catalog seeding script + UPDATE queue row to status='promoted'">Promote (SQL)</span>
              <button onClick={() => props.onAction("reject")} className="rounded bg-gray-400 px-2 py-1 text-white hover:bg-gray-500">Reject</button>
            </div>
          )}
          {props.row.status === "promoted" && <span className="text-green-700">→ resolved</span>}
          {props.row.status === "rejected" && <span className="text-gray-500" title={props.row.rejection_reason ?? ""}>rejected</span>}
        </td>
      </tr>
      {props.isActionTarget && props.actionMode === "reject" && (
        <tr className="border-b border-gray-100 bg-amber-50">
          <td colSpan={7} className="p-3">
            <label className="text-xs">Rejection reason
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-xs" />
            </label>
            <div className="mt-2 flex gap-2">
              <button
                disabled={submitting || !reason.trim()}
                onClick={async () => {
                  setSubmitting(true);
                  await props.onReject(reason.trim());
                  setSubmitting(false);
                }}
                className="rounded bg-amber-600 px-3 py-1.5 text-xs text-white hover:bg-amber-700 disabled:bg-gray-300"
              >
                {submitting ? "Rejecting..." : "Confirm Reject"}
              </button>
              <button onClick={props.onCancel} className="rounded bg-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-400">Cancel</button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const classes =
    status === "pending" ? "bg-amber-100 text-amber-700" :
    status === "promoted" ? "bg-green-100 text-green-700" :
    status === "rejected" ? "bg-gray-200 text-gray-600" :
    "bg-gray-100 text-gray-500";
  return <span className={`rounded px-2 py-0.5 text-xs ${classes}`}>{status}</span>;
}
