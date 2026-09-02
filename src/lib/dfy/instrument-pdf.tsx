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
 */
import { Document, Page, Text, View, StyleSheet, Font } from "@react-pdf/renderer";
import type { RenderedInstrument } from "./paper";

Font.registerHyphenationCallback((word) => [word]);

const C = { ink: "#0f172a", body: "#1e293b", sub: "#475569", muted: "#64748b", line: "#e2e8f0", brand: "#2563eb", card: "#f8fafc" };

const styles = StyleSheet.create({
  page: { paddingTop: 56, paddingBottom: 64, paddingHorizontal: 52, fontFamily: "Helvetica", fontSize: 10.5, color: C.body },
  header: { position: "absolute", top: 26, left: 52, right: 52, fontSize: 8, color: C.muted, flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 0.5, borderBottomColor: C.line, paddingBottom: 6, lineHeight: 1.2 },
  footer: { position: "absolute", bottom: 28, left: 52, right: 52, fontSize: 8, color: C.muted, flexDirection: "row", justifyContent: "space-between", borderTopWidth: 0.5, borderTopColor: C.line, paddingTop: 6, lineHeight: 1.2 },
  eyebrow: { fontSize: 8.5, letterSpacing: 2, textTransform: "uppercase", color: C.brand, marginBottom: 10, lineHeight: 1.2 },
  title: { fontSize: 18, fontWeight: 700, color: C.ink, marginBottom: 6, lineHeight: 1.25 },
  sub: { fontSize: 9.5, color: C.sub, marginBottom: 16, lineHeight: 1.3 },
  body: { fontSize: 10.5, lineHeight: 1.55, color: C.body },
  bodyAuthorization: { fontSize: 14, lineHeight: 1.5, color: C.ink, borderWidth: 1.2, borderColor: C.ink, padding: 14, marginBottom: 8 },
  sig: { marginTop: 22, backgroundColor: C.card, borderWidth: 0.5, borderColor: C.line, borderRadius: 4, padding: 12 },
  sigTitle: { fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: C.brand, marginBottom: 8, lineHeight: 1.2 },
  sigRow: { flexDirection: "row", marginBottom: 4 },
  sigLabel: { width: 130, fontSize: 9.5, color: C.muted, lineHeight: 1.3 },
  sigValue: { flex: 1, fontSize: 9.5, color: C.ink, lineHeight: 1.3 },
  counter: { marginTop: 12, fontSize: 9.5, color: C.sub, lineHeight: 1.4 },
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
  const signedDate = signature ? new Date(signature.signedAt).toLocaleString("en-US", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }) : "";
  return (
    <Document title={instrument.title}>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header} fixed>
          <Text>Candid · {instrument.title}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
        <View style={styles.footer} fixed>
          <Text>Engagement {engagementId}</Text>
          <Text>Instrument hash {instrument.hash.slice(0, 16)}…</Text>
        </View>
        <Text style={styles.eyebrow}>Candid · Done-for-you appeal execution</Text>
        <Text style={styles.title}>{instrument.title}</Text>
        <Text style={styles.sub}>Version {instrument.version} · effective {instrument.effectiveDate} · {signature ? "signed instance" : "print form — sign by hand"}</Text>
        <Text style={instrument.authorizationForm ? styles.bodyAuthorization : styles.body}>{instrument.text}</Text>
        {!signature ? (
          <View style={styles.sig} wrap={false}>
            <Text style={styles.sigTitle}>Signature (by hand)</Text>
            <View style={styles.sigRow}><Text style={styles.sigLabel}>Signature</Text><Text style={styles.sigValue}>________________________________________</Text></View>
            <View style={styles.sigRow}><Text style={styles.sigLabel}>Printed name</Text><Text style={styles.sigValue}>________________________________________</Text></View>
            <View style={styles.sigRow}><Text style={styles.sigLabel}>Date</Text><Text style={styles.sigValue}>____________________</Text></View>
            <Text style={styles.counter}>Sign and date by hand, then upload the signed pages to your Candid documents. Your typed acceptance on the Candid page remains on file as well.</Text>
          </View>
        ) : (
        <View style={styles.sig} wrap={false}>
          <Text style={styles.sigTitle}>Electronic signature</Text>
          <View style={styles.sigRow}><Text style={styles.sigLabel}>Signed by (typed)</Text><Text style={styles.sigValue}>{signature.signedName}</Text></View>
          <View style={styles.sigRow}><Text style={styles.sigLabel}>Date and time</Text><Text style={styles.sigValue}>{signedDate}</Text></View>
          <View style={styles.sigRow}><Text style={styles.sigLabel}>Consent record</Text><Text style={styles.sigValue}>{signature.consentEventId}</Text></View>
          <View style={styles.sigRow}><Text style={styles.sigLabel}>Document hash (SHA-256)</Text><Text style={styles.sigValue}>{instrument.hash}</Text></View>
          <View style={styles.sigRow}><Text style={styles.sigLabel}>Captured from</Text><Text style={styles.sigValue}>{signature.ip ?? "—"}{signature.userAgent ? ` · ${signature.userAgent.slice(0, 80)}` : ""}</Text></View>
          {counterparty ? <Text style={styles.counter}>{counterparty}</Text> : null}
        </View>
        )}
      </Page>
    </Document>
  );
}
