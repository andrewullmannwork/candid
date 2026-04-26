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

const styles = StyleSheet.create({
  page: {
    paddingTop: 56,
    paddingBottom: 64,
    paddingHorizontal: 48,
    fontFamily: "Helvetica",
    fontSize: 10.5,
    lineHeight: 1.55,
    color: "#0f172a",
  },
  header: {
    position: "absolute",
    top: 24,
    left: 48,
    right: 48,
    fontSize: 8.5,
    color: "#64748b",
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 0.5,
    borderBottomColor: "#e2e8f0",
    paddingBottom: 4,
  },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 48,
    right: 48,
    fontSize: 8.5,
    color: "#64748b",
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 0.5,
    borderTopColor: "#e2e8f0",
    paddingTop: 4,
  },
  cover: {
    marginBottom: 32,
  },
  coverEyebrow: {
    fontSize: 9,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: "#3730a3",
    marginBottom: 10,
  },
  coverTitle: {
    fontSize: 26,
    fontWeight: 700,
    marginBottom: 8,
    color: "#0f172a",
  },
  coverSub: {
    fontSize: 12,
    color: "#475569",
    marginBottom: 16,
  },
  coverMeta: {
    fontSize: 10,
    color: "#475569",
    marginBottom: 2,
  },
  toc: {
    marginTop: 20,
    paddingTop: 12,
    borderTopWidth: 0.5,
    borderTopColor: "#e2e8f0",
  },
  tocTitle: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginBottom: 8,
    color: "#1e293b",
  },
  tocRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 10,
    marginBottom: 3,
    color: "#334155",
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginTop: 18,
    marginBottom: 8,
  },
  sectionRule: {
    width: 3,
    marginRight: 10,
    backgroundColor: "#2563eb",
    alignSelf: "stretch",
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: "#0f172a",
    flexShrink: 1,
  },
  sectionContent: {
    fontSize: 10.5,
    color: "#1e293b",
    whiteSpace: "pre-wrap",
  },
  sectionDisclaimer: {
    marginTop: 6,
    fontSize: 8.5,
    color: "#b45309",
    fontStyle: "italic",
  },
  letterBody: {
    fontFamily: "Courier",
    fontSize: 10,
    lineHeight: 1.5,
    backgroundColor: "#f8fafc",
    padding: 12,
    borderRadius: 4,
    color: "#0f172a",
  },
  masterDisclaimer: {
    marginTop: 32,
    paddingTop: 12,
    borderTopWidth: 0.5,
    borderTopColor: "#e2e8f0",
    fontSize: 9,
    color: "#64748b",
    fontStyle: "italic",
  },
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
          <Text style={styles.coverMeta}>
            Plan: {formatPlanLabel(pkg.planContext)}
          </Text>
          <Text style={styles.coverMeta}>
            Total billed: {formatUsd(pkg.evidence?.totals.totalBilled ?? 0)}
          </Text>
          <Text style={styles.coverMeta}>
            Line items in dispute: {pkg.evidence?.totals.lineItemCount ?? 0}
          </Text>
          <View style={styles.toc}>
            <Text style={styles.tocTitle}>Contents</Text>
            {pkg.sections.map((s, i) => (
              <View key={`toc-${i}`} style={styles.tocRow}>
                <Text>{s.title}</Text>
              </View>
            ))}
          </View>
        </View>

        {pkg.sections.map((section, i) => (
          <View key={`sec-${i}`} wrap={false}>
            <View style={styles.sectionHeaderRow}>
              <View style={styles.sectionRule} />
              <Text style={styles.sectionTitle}>{section.title}</Text>
            </View>
            {/* Section 0 renders verbatim in a fixed-width block. */}
            {section.title.startsWith("0.") ? (
              <Text style={styles.letterBody}>{section.content}</Text>
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

function formatPlanLabel(pc: PlanContext | null | undefined): string {
  if (!pc?.plan) return "—";
  const name = pc.plan.planName ?? "Plan";
  const year = pc.plan.planYear ? `, ${pc.plan.planYear}` : "";
  const insurer = pc.insurer?.name ?? pc.plan.insurerName ?? "";
  return `${name}${year}${insurer ? ` · ${insurer}` : ""}`;
}

function formatUsd(n: number): string {
  const v = Math.round(n * 100) / 100;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
