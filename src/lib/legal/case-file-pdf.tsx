/**
 * case-file-pdf — Phase 5 styled PDF output
 *
 * Builds a PDF from an EvidencePackage using @react-pdf/renderer. Called by
 * /api/legal/evidence-package when the client requests `?format=pdf`.
 *
 * Styling matches the redesigned dispute letter UI:
 *   - Inter-like system font stack (Helvetica on PDF; ~closest neutral sans)
 *   - Blue / indigo accents
 *   - Generous margins, line spacing 1.55
 *   - Section headers with colored left rule
 *   - Page headers (left: "Candid Case File · {provider}", right: page #)
 *   - Page footers (left: dispute ref ID, right: generation date)
 */
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Font,
} from "@react-pdf/renderer";
import type { EvidencePackage } from "./evidence-compiler";
import type { PlanContext } from "@/lib/disputes/plan-context";

// Register a system-safe font. @react-pdf ships Helvetica by default; we alias
// it to keep the stylesheet readable.
Font.registerHyphenationCallback((word) => [word]);

// Candid palette (mirrors the app: slate ink + blue accent).
const C = {
  ink: "#0f172a",
  body: "#1e293b",
  sub: "#475569",
  muted: "#64748b",
  line: "#e2e8f0",
  brand: "#2563eb",
  brandInk: "#1e3a8a",
  amber: "#b45309",
  card: "#f8fafc",
};

// NOTE: @react-pdf computes line boxes per-Text, and a global unitless
// lineHeight cascades unreliably to large headings (causes the cover overlap we
// hit). So we set an explicit lineHeight on EVERY text style + generous margins.
const styles = StyleSheet.create({
  page: {
    paddingTop: 60,
    paddingBottom: 72,
    paddingHorizontal: 52,
    fontFamily: "Helvetica",
    fontSize: 10.5,
    color: C.body,
  },
  header: {
    position: "absolute",
    top: 28,
    left: 52,
    right: 52,
    fontSize: 8,
    color: C.muted,
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 0.5,
    borderBottomColor: C.line,
    paddingBottom: 6,
    lineHeight: 1.2,
  },
  footer: {
    position: "absolute",
    bottom: 30,
    left: 52,
    right: 52,
    fontSize: 8,
    color: C.muted,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 0.5,
    borderTopColor: C.line,
    paddingTop: 6,
    lineHeight: 1.2,
  },
  // ── Cover ──
  cover: {
    marginBottom: 26,
  },
  coverEyebrow: {
    fontSize: 8.5,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: C.brand,
    marginBottom: 14,
    lineHeight: 1.2,
  },
  coverTitle: {
    fontSize: 23,
    fontWeight: 700,
    color: C.ink,
    marginBottom: 12,
    lineHeight: 1.25,
  },
  coverSub: {
    fontSize: 11,
    color: C.sub,
    marginBottom: 18,
    lineHeight: 1.3,
  },
  metaCard: {
    backgroundColor: C.card,
    borderWidth: 0.5,
    borderColor: C.line,
    borderRadius: 6,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  metaRow: {
    flexDirection: "row",
    marginBottom: 5,
    lineHeight: 1.3,
  },
  metaRowLast: {
    flexDirection: "row",
    lineHeight: 1.3,
  },
  metaLabel: {
    fontSize: 9.5,
    color: C.muted,
    width: 120,
  },
  metaValue: {
    fontSize: 9.5,
    color: C.body,
    flexShrink: 1,
  },
  toc: {
    marginTop: 22,
    paddingTop: 16,
    borderTopWidth: 0.5,
    borderTopColor: C.line,
  },
  tocTitle: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginBottom: 12,
    color: C.sub,
    lineHeight: 1.2,
  },
  tocRow: {
    fontSize: 10,
    marginBottom: 7,
    color: C.body,
    lineHeight: 1.3,
  },
  // ── Sections ──
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 22,
    marginBottom: 10,
  },
  sectionRule: {
    width: 3,
    height: 15,
    marginRight: 10,
    borderRadius: 2,
    backgroundColor: C.brand,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: C.ink,
    flexShrink: 1,
    lineHeight: 1.25,
  },
  sectionContent: {
    fontSize: 10.5,
    color: C.body,
    lineHeight: 1.5,
  },
  sectionDisclaimer: {
    marginTop: 8,
    fontSize: 8.5,
    color: C.amber,
    fontStyle: "italic",
    lineHeight: 1.4,
  },
  letterBody: {
    fontSize: 10,
    lineHeight: 1.55,
    backgroundColor: C.card,
    borderWidth: 0.5,
    borderColor: C.line,
    padding: 16,
    borderRadius: 6,
    color: C.ink,
  },
  masterDisclaimer: {
    marginTop: 28,
    paddingTop: 14,
    borderTopWidth: 0.5,
    borderTopColor: C.line,
    fontSize: 8.5,
    color: C.muted,
    fontStyle: "italic",
    lineHeight: 1.45,
  },
  // ── Claim Summary table (Section 1) ──
  claimMeta: {
    fontSize: 9.5,
    color: C.sub,
    marginBottom: 10,
    lineHeight: 1.45,
  },
  table: {
    borderWidth: 0.5,
    borderColor: C.line,
    borderRadius: 6,
    overflow: "hidden",
  },
  tr: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: C.line,
  },
  trHead: {
    backgroundColor: C.card,
  },
  th: {
    fontSize: 7.5,
    fontWeight: 700,
    color: C.muted,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    paddingVertical: 6,
    paddingHorizontal: 7,
    lineHeight: 1.3,
  },
  td: {
    fontSize: 9,
    color: C.body,
    paddingVertical: 6,
    paddingHorizontal: 7,
    lineHeight: 1.35,
  },
  colService: { flex: 3 },
  colCode: { flex: 2 },
  colNum: { flex: 1.5, textAlign: "right" },
});

interface Props {
  pkg: EvidencePackage;
  providerName?: string | null;
  referenceId?: string | null;
}

export function CaseFilePdf({ pkg, providerName, referenceId }: Props) {
  const generated = new Date(pkg.generatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const refLabel = (referenceId ?? pkg.title.replace("Evidence Package — Claim ", "")).toUpperCase();
  const headerLeft = `Candid Case File · ${providerName ?? "—"}`;

  return (
    <Document title={pkg.title}>
      <Page size="LETTER" style={styles.page}>
        <Header left={headerLeft} />
        <Footer left={`Ref: ${refLabel}`} right={`Generated ${generated}`} />

        <View style={styles.cover}>
          <Text style={styles.coverEyebrow}>CANDID · CASE FILE</Text>
          <Text style={styles.coverTitle}>{pkg.title}</Text>
          <Text style={styles.coverSub}>Generated {generated}</Text>
          <View style={styles.metaCard}>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Plan</Text>
              <Text style={styles.metaValue}>{formatPlanLabel(pkg.planContext)}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Total billed</Text>
              <Text style={styles.metaValue}>{formatUsd(pkg.evidence?.totals.totalBilled ?? 0)}</Text>
            </View>
            <View style={styles.metaRowLast}>
              <Text style={styles.metaLabel}>Line items in dispute</Text>
              <Text style={styles.metaValue}>{pkg.evidence?.totals.lineItemCount ?? 0}</Text>
            </View>
          </View>
          <View style={styles.toc}>
            <Text style={styles.tocTitle}>Contents</Text>
            {pkg.sections.map((s, i) => (
              <Text key={`toc-${i}`} style={styles.tocRow}>{s.title}</Text>
            ))}
          </View>
        </View>

        {pkg.sections.map((section, i) => (
          <View key={`sec-${i}`}>
            {/* Keep the colored-rule header with its first content; never orphan
                it at a page bottom. The section itself WRAPS (no wrap={false}) so
                the long letter paginates instead of overflowing the footer. */}
            <View style={styles.sectionHeaderRow} wrap={false} minPresenceAhead={48}>
              <View style={styles.sectionRule} />
              <Text style={styles.sectionTitle}>{section.title}</Text>
            </View>
            {/* Section 0 (the verbatim letter) renders in a subtle card;
                Section 1 (Claim Summary) renders as a real table from the
                structured evidence; everything else is the string content. */}
            {section.title.startsWith("0.") ? (
              <Text style={styles.letterBody}>{section.content}</Text>
            ) : section.title.startsWith("1.") && pkg.evidence?.claims?.[0] ? (
              <ClaimSummaryTable claim={pkg.evidence.claims[0]} />
            ) : (
              <Text style={styles.sectionContent}>{section.content}</Text>
            )}
            {section.disclaimer ? (
              <Text style={styles.sectionDisclaimer}>{section.disclaimer}</Text>
            ) : null}
          </View>
        ))}

        <Text style={styles.masterDisclaimer}>{pkg.masterDisclaimer}</Text>
      </Page>
    </Document>
  );
}

function Header({ left }: { left: string }) {
  return (
    <View style={styles.header} fixed>
      <Text>{left}</Text>
      <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );
}

function Footer({ left, right }: { left: string; right: string }) {
  return (
    <View style={styles.footer} fixed>
      <Text>{left}</Text>
      <Text>{right}</Text>
    </View>
  );
}

type ClaimRow = NonNullable<EvidencePackage["evidence"]>["claims"][number];

function ClaimSummaryTable({ claim }: { claim: ClaimRow }) {
  return (
    <View>
      <Text style={styles.claimMeta}>
        Date of service: {claim.dateOfService ?? "Unknown"}   ·   Provider:{" "}
        {claim.providerName ?? "Unknown"}   ·   Plan year: {claim.planYear ?? "Unknown"}   ·   Total billed:{" "}
        {formatUsd(claim.totalBilled)}
      </Text>
      <View style={styles.table}>
        <View style={[styles.tr, styles.trHead]}>
          <Text style={[styles.th, styles.colService]}>Service</Text>
          <Text style={[styles.th, styles.colCode]}>Code</Text>
          <Text style={[styles.th, styles.colNum]}>Billed</Text>
          <Text style={[styles.th, styles.colNum]}>Ins. paid</Text>
          <Text style={[styles.th, styles.colNum]}>Patient</Text>
        </View>
        {claim.lineItemEvidence.map((li, i) => (
          <View key={i} style={styles.tr} wrap={false}>
            <Text style={[styles.td, styles.colService]}>{li.serviceName}</Text>
            <Text style={[styles.td, styles.colCode]}>
              {li.billingCode ? `${li.billingCode.type} ${li.billingCode.value}` : "—"}
            </Text>
            <Text style={[styles.td, styles.colNum]}>{formatUsd(li.billedAmount)}</Text>
            <Text style={[styles.td, styles.colNum]}>{formatUsd(li.insurancePaid ?? 0)}</Text>
            <Text style={[styles.td, styles.colNum]}>{formatUsd(li.patientOwes ?? 0)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function formatPlanLabel(pc: PlanContext | null | undefined): string {
  // Prefer the exact-year resolved plan; fall back to the user's plan on file
  // (fallbackPlan) so the Case File shows their plan instead of "—" when the
  // year/active resolver can't make an exact match.
  const p = pc?.plan ?? pc?.fallbackPlan;
  if (!p) return "—";
  const name = p.planName ?? "Plan";
  const year = p.planYear ? `, ${p.planYear}` : "";
  const insurer = pc?.insurer?.name ?? p.insurerName ?? "";
  return `${name}${year}${insurer ? ` · ${insurer}` : ""}`;
}

function formatUsd(n: number): string {
  const v = Math.round(n * 100) / 100;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
