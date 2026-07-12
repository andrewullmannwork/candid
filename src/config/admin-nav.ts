// Single source of truth for the Candid admin surface.
//
// Both the admin sidebar (grouped, collapsible nav) and each page's "Ops" link
// (which deep-links into the operations manual at /admin/ops) read from this one
// registry, so the two can never drift out of sync.
//
// INVARIANT: every page's `opsSlug` must match the anchor of its section in
// `docs/admin-operations.md`. The ops manual renders heading anchors via
// rehype-slug, and `scripts/check-admin-ops-anchors.mjs` fails if any slug here
// has no matching section there — so a renamed heading breaks the build loudly
// instead of shipping a dead "Ops" link.

export type AdminNavItem = {
  href: string;
  label: string;
  /** Anchor of this page's section in the ops manual: /admin/ops#<opsSlug>. */
  opsSlug: string;
};

export type AdminNavGroup = {
  label: string;
  defaultOpen?: boolean;
  items: AdminNavItem[];
};

export const ADMIN_DASHBOARD: AdminNavItem = {
  href: "/admin/dashboard",
  label: "To-Do Center",
  opsSlug: "to-do-center",
};

export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  {
    label: "Growth",
    defaultOpen: true,
    items: [{ href: "/admin/growth", label: "Growth Metrics", opsSlug: "growth-metrics" }],
  },
  {
    label: "Queues",
    defaultOpen: true,
    items: [
      { href: "/admin/documents/review", label: "Document Review", opsSlug: "document-review" },
      { href: "/admin/documents/blocklist", label: "Hash Blocklist", opsSlug: "hash-blocklist" },
      { href: "/admin/review-queue", label: "Review Queue", opsSlug: "review-queue" },
      { href: "/admin/corrections", label: "Benefit Corrections", opsSlug: "benefit-corrections" },
      { href: "/admin/sbc-tickets", label: "SBC Tickets", opsSlug: "sbc-tickets" },
      { href: "/admin/tickets", label: "Support Tickets", opsSlug: "support-tickets" },
      { href: "/admin/insurer-appeals", label: "Insurer Appeals", opsSlug: "insurer-appeals" },
      { href: "/admin/cost-cap", label: "Cost-Cap", opsSlug: "cost-cap" },
    ],
  },
  {
    label: "Claims & Plans",
    items: [
      { href: "/admin/claims", label: "Claims & Disputes", opsSlug: "claims-and-disputes" },
      { href: "/admin/plan-aca-overrides", label: "Plan ACA Overrides", opsSlug: "plan-aca-overrides" },
    ],
  },
  {
    label: "Data Quality · Needs action",
    defaultOpen: true,
    items: [
      { href: "/admin/code-identity-review", label: "Code Identity — Review", opsSlug: "code-identity-review" },
      { href: "/admin/code-identity-disambiguate", label: "Code Identity — Disambiguate", opsSlug: "code-identity-disambiguate" },
      { href: "/admin/promotion-quarantine", label: "Promotion Quarantine", opsSlug: "promotion-quarantine" },
      { href: "/admin/pipeline", label: "Benefit Pipeline", opsSlug: "benefit-pipeline" },
    ],
  },
  {
    label: "Data Quality · Monitoring",
    items: [
      { href: "/admin/code-identity-seeds", label: "Code Identity — Seeds", opsSlug: "code-identity-seeds" },
      { href: "/admin/canonical-quality", label: "Canonical Quality", opsSlug: "canonical-quality" },
      { href: "/admin/canonical-match-decisions", label: "Canonical Match Decisions", opsSlug: "canonical-match-decisions" },
      { href: "/admin/recoding-outcomes", label: "Recoding Outcomes", opsSlug: "recoding-outcomes" },
      { href: "/admin/cost-per-canonical", label: "Cost per Canonical", opsSlug: "cost-per-canonical" },
      { href: "/admin/auto-reparse-stats", label: "Auto-Reparse Stats", opsSlug: "auto-reparse-stats" },
      { href: "/admin/parse-audit-runs", label: "Parse Audit Runs", opsSlug: "parse-audit-runs" },
    ],
  },
  {
    label: "Config",
    items: [
      { href: "/admin/settings", label: "Settings", opsSlug: "settings" },
      { href: "/admin/flags", label: "Feature Flags", opsSlug: "feature-flags" },
      { href: "/admin/upload-settings", label: "Upload Settings", opsSlug: "upload-settings" },
      { href: "/admin/classifier-fallback-settings", label: "Classifier Settings", opsSlug: "classifier-settings" },
    ],
  },
  {
    label: "Accounts",
    items: [
      { href: "/admin/users", label: "Users", opsSlug: "users" },
      { href: "/admin/subscriptions", label: "Subscriptions", opsSlug: "subscriptions" },
      { href: "/admin/consent", label: "Consent Audit", opsSlug: "consent-audit" },
    ],
  },
];

/** Dashboard + every grouped item, flattened, each tagged with its group label. */
export const ADMIN_PAGES: Array<AdminNavItem & { group: string | null }> = [
  { ...ADMIN_DASHBOARD, group: null },
  ...ADMIN_NAV_GROUPS.flatMap((g) => g.items.map((it) => ({ ...it, group: g.label }))),
];

/**
 * Registry entry for the current admin path. Tries an exact match first, then
 * the longest `href` that is a path-prefix (so nested routes like
 * `/admin/documents/review/123` still resolve to Document Review).
 */
export function adminPageFor(pathname: string): (AdminNavItem & { group: string | null }) | null {
  const exact = ADMIN_PAGES.find((p) => p.href === pathname);
  if (exact) return exact;
  const prefixed = ADMIN_PAGES.filter((p) => pathname === p.href || pathname.startsWith(p.href + "/")).sort(
    (a, b) => b.href.length - a.href.length,
  );
  return prefixed[0] ?? null;
}
