/**
 * instrument-pdf — renders a signed DFY instrument to PDF with the EXISTING
 * @react-pdf/renderer (the letter pipeline's own dependency; the case-file PDF
 * is the styling precedent). One document, one instrument: the exact signed
 * text, then the electronic-signature block that proves who signed what and
 * when (typed name, date, the instance hash, the capture metadata).
 *
 * The authorization renders at 14 points and in its own bordered block —
 * Cal. Civ. Code §56.11's typeface + separateness requirements, in the PDF as
 * on screen.
 *
 * Typefaces are the renderer's built-ins only (Helvetica, Times) — nothing is
 * fetched at render time, so the fixture and the DEV proof run offline. The
 * signature line is set in Times-Italic, the closest built-in to a hand.
 */
import { Document, Page, Text, View, StyleSheet, Font } from "@react-pdf/renderer";
import type { RenderedInstrument } from "./paper";

Font.registerHyphenationCallback((word) => [word]);

const C = { ink: "#0f172a", body: "#1e293b", sub: "#475569", muted: "#64748b", line: "#e2e8f0", rule: "#94a3b8", brand: "#2563eb", card: "#f8fafc", ok: "#047857", okBg: "#ecfdf5", okLine: "#a7f3d0" };

const styles = StyleSheet.create({
  page: { paddingTop: 64, paddingBottom: 66, paddingHorizontal: 56, fontFamily: "Helvetica", fontSize: 10.5, color: C.body },
  header: { position: "absolute", top: 24, left: 56, right: 56, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 0.6, borderBottomColor: C.line, paddingBottom: 8 },
  brand: { flexDirection: "row", alignItems: "center" },
  brandMark: { width: 11, height: 11, borderRadius: 3, backgroundColor: C.brand, marginRight: 5 },
  brandName: { fontSize: 9.5, fontFamily: "Helvetica-Bold", color: C.ink, letterSpacing: 0.2 },
  headerRight: { fontSize: 8, color: C.muted },
  footer: { position: "absolute", bottom: 26, left: 56, right: 56, fontSize: 7.5, color: C.muted, flexDirection: "row", justifyContent: "space-between", borderTopWidth: 0.6, borderTopColor: C.line, paddingTop: 7, lineHeight: 1.2 },
  eyebrow: { fontSize: 8, letterSpacing: 2, textTransform: "uppercase", color: C.brand, marginBottom: 10, lineHeight: 1.2, fontFamily: "Helvetica-Bold" },
  title: { fontSize: 20, fontFamily: "Helvetica-Bold", color: C.ink, marginBottom: 6, lineHeight: 1.2 },
  sub: { fontSize: 9, color: C.sub, marginBottom: 18, lineHeight: 1.3 },
  body: { fontSize: 10.5, lineHeight: 1.6, color: C.body },
  bodyAuthorization: { fontSize: 14, lineHeight: 1.5, color: C.ink, borderWidth: 1.2, borderColor: C.ink, padding: 16, marginBottom: 8 },

  /* signature block */
  sig: { marginTop: 26, borderWidth: 0.8, borderColor: C.line, borderRadius: 6, overflow: "hidden" },
  sigHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: C.card, paddingVertical: 7, paddingHorizontal: 14, borderBottomWidth: 0.6, borderBottomColor: C.line },
  sigTitle: { fontSize: 8, letterSpacing: 1.6, textTransform: "uppercase", color: C.sub, fontFamily: "Helvetica-Bold", lineHeight: 1.2 },
  sigBadge: { fontSize: 7.5, color: C.ok, backgroundColor: C.okBg, borderWidth: 0.6, borderColor: C.okLine, borderRadius: 8, paddingVertical: 2, paddingHorizontal: 7, fontFamily: "Helvetica-Bold", letterSpacing: 0.6, textTransform: "uppercase" },
  sigBody: { paddingVertical: 14, paddingHorizontal: 14 },
  sigScript: { fontFamily: "Times-Italic", fontSize: 26, color: C.ink, lineHeight: 1.1, marginBottom: 4 },
  sigRule: { borderTopWidth: 0.9, borderTopColor: C.rule, marginTop: 2, paddingTop: 5, flexDirection: "row", justifyContent: "space-between" },
  sigCaption: { fontSize: 8.5, color: C.sub, lineHeight: 1.3 },
  sigMeta: { marginTop: 12, borderTopWidth: 0.6, borderTopColor: C.line, paddingTop: 9 },
  metaRow: { flexDirection: "row", marginBottom: 3.5 },
  metaLabel: { width: 118, fontSize: 7.8, color: C.muted, lineHeight: 1.3, textTransform: "uppercase", letterSpacing: 0.6 },
  metaValue: { flex: 1, fontSize: 8.4, color: C.body, lineHeight: 1.3 },
  counter: { marginTop: 10, borderTopWidth: 0.6, borderTopColor: C.line, paddingTop: 8, fontSize: 9, color: C.sub, lineHeight: 1.45 },

  /* the print (wet-ink) form */
  inkGrid: { flexDirection: "row", marginTop: 6 },
  inkCell: { flex: 1, marginRight: 18 },
  inkCellLast: { width: 150 },
  inkLine: { borderBottomWidth: 0.9, borderBottomColor: C.ink, height: 30 },
  inkLabel: { fontSize: 8, color: C.muted, marginTop: 4, textTransform: "uppercase", letterSpacing: 0.6 },
  inkNote: { marginTop: 12, fontSize: 9, color: C.sub, lineHeight: 1.45 },
});

export interface InstrumentSignature {
  signedName: string;
  /** ISO timestamp of capture. */
  signedAt: string;
  ip: string | null;
  userAgent: string | null;
  consentEventId: string;
}

export interface InstrumentPdfProps {
  instrument: RenderedInstrument;
  /** null = the UNSIGNED print form (wet-ink path): handwritten signature + date lines. */
  signature: InstrumentSignature | null;
  /** The counterparty line for the designation ("Accepted: Airgetlam Labs LLC, by …") — null for the others. */
  counterparty: string | null;
  engagementId: string;
}

export function InstrumentPdf({ instrument, signature, counterparty, engagementId }: InstrumentPdfProps) {
  const signedDate = signature ? new Date(signature.signedAt).toLocaleString("en-US", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "";
  return (
    <Document title={instrument.title} author="Candid (Airgetlam Labs LLC)" subject={`${instrument.title} · engagement ${engagementId}`}>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header} fixed>
          <View style={styles.brand}><View style={styles.brandMark} /><Text style={styles.brandName}>Candid</Text></View>
          <Text style={styles.headerRight} render={({ pageNumber, totalPages }) => `${instrument.title} · page ${pageNumber} of ${totalPages}`} />
        </View>
        <View style={styles.footer} fixed>
          <Text>Engagement {engagementId}</Text>
          <Text>Instrument hash {instrument.hash.slice(0, 16)}…</Text>
        </View>

        <Text style={styles.eyebrow}>Done-for-you appeal execution</Text>
        <Text style={styles.title}>{instrument.title}</Text>
        <Text style={styles.sub}>Version {instrument.version} · effective {instrument.effectiveDate} · {signature ? "signed instance" : "print form — sign by hand"}</Text>
        <Text style={instrument.authorizationForm ? styles.bodyAuthorization : styles.body}>{instrument.text}</Text>

        {!signature ? (
          <View style={styles.sig} wrap={false}>
            <View style={styles.sigHead}><Text style={styles.sigTitle}>Signature · by hand</Text></View>
            <View style={styles.sigBody}>
              <View style={styles.inkGrid}>
                <View style={styles.inkCell}><View style={styles.inkLine} /><Text style={styles.inkLabel}>Signature</Text></View>
                <View style={styles.inkCellLast}><View style={styles.inkLine} /><Text style={styles.inkLabel}>Date</Text></View>
              </View>
              <View style={styles.inkGrid}>
                <View style={styles.inkCell}><View style={styles.inkLine} /><Text style={styles.inkLabel}>Printed name</Text></View>
              </View>
              <Text style={styles.inkNote}>Sign and date by hand, then upload the signed pages to your Candid documents. Your typed acceptance on the Candid page remains on file as well.</Text>
            </View>
          </View>
        ) : (
          <View style={styles.sig} wrap={false}>
            <View style={styles.sigHead}>
              <Text style={styles.sigTitle}>Electronic signature</Text>
              <Text style={styles.sigBadge}>Signed</Text>
            </View>
            <View style={styles.sigBody}>
              <Text style={styles.sigScript}>{signature.signedName}</Text>
              <View style={styles.sigRule}>
                <Text style={styles.sigCaption}>Signed electronically by {signature.signedName}</Text>
                <Text style={styles.sigCaption}>{signedDate}</Text>
              </View>
              <View style={styles.sigMeta}>
                <View style={styles.metaRow}><Text style={styles.metaLabel}>Consent record</Text><Text style={styles.metaValue}>{signature.consentEventId}</Text></View>
                <View style={styles.metaRow}><Text style={styles.metaLabel}>Document hash</Text><Text style={styles.metaValue}>SHA-256 {instrument.hash}</Text></View>
                <View style={styles.metaRow}><Text style={styles.metaLabel}>Captured from</Text><Text style={styles.metaValue}>{signature.ip ?? "—"}{signature.userAgent ? ` · ${signature.userAgent.slice(0, 90)}` : ""}</Text></View>
              </View>
              {counterparty ? <Text style={styles.counter}>{counterparty}</Text> : null}
            </View>
          </View>
        )}
      </Page>
    </Document>
  );
}
