/**
 * appeal-letter-pdf — the member's appeal letter as a printable page (S331).
 *
 * The letter is STORED as text and the member downloads it that way. An
 * operator has to print it and put it in an envelope, so it needs a page.
 *
 * Deliberately unbranded and unstamped. `InstrumentPdf` — the other PDF in this
 * lane — carries a Candid wordmark, the engagement id and an instrument hash in
 * its footer, which is right for a consent instrument and wrong for a letter
 * mailed to an insurer: this is the MEMBER's letter, already carrying its own
 * sender block, date, recipient block and signature line. Rendering it adds a
 * page, never a voice.
 *
 * The text is reproduced verbatim, blank lines and all, so the printed page
 * matches the letter the member adopted.
 */
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";

const styles = StyleSheet.create({
  page: {
    paddingTop: 64,
    paddingBottom: 64,
    paddingHorizontal: 72,
    fontFamily: "Times-Roman",
    fontSize: 11,
    lineHeight: 1.45,
    color: "#111111",
  },
  block: { marginBottom: 9 },
  line: { fontFamily: "Times-Roman" },
  pageNo: {
    position: "absolute",
    bottom: 32,
    left: 72,
    right: 72,
    textAlign: "center",
    fontSize: 9,
    color: "#666666",
  },
});

/** Blank-line-separated blocks, so page breaks fall between paragraphs. */
function blocksOf(text: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.trim() === "") {
      if (cur.length) out.push(cur);
      cur = [];
    } else {
      cur.push(raw);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

export function AppealLetterPdf({ text, title }: { text: string; title: string }) {
  return (
    <Document title={title}>
      <Page size="LETTER" style={styles.page} wrap>
        {blocksOf(text).map((lines, i) => (
          <View key={i} style={styles.block} wrap={false}>
            {lines.map((l, j) => (
              <Text key={j} style={styles.line}>{l}</Text>
            ))}
          </View>
        ))}
        <Text
          style={styles.pageNo}
          fixed
          render={({ pageNumber, totalPages }) => `${pageNumber} of ${totalPages}`}
        />
      </Page>
    </Document>
  );
}
