// S330 — render ONE signed instrument + ONE print form to the scratchpad, no DB (a look at the layout).
import { renderToBuffer } from "@react-pdf/renderer";
import { writeFileSync } from "node:fs";
import { InstrumentPdf } from "../src/lib/dfy/instrument-pdf";
import { renderInstrument } from "../src/lib/dfy/paper";
const out = process.argv[2] || "/tmp";
const ctx = { memberName: "Andrew Ullmann", memberEmail: "andrew@example.com", planName: "Blue Shield of California PPO", insurerName: "Blue Shield of California", claimRef: "2a8f87c6", dateOfService: "2025-09-12", channel: "plan_internal_grievance" as const, namedParty: "individual" as const, operatorName: "Andrew Ullmann", feeCents: 0, sponsorRef: null, effectiveDate: "2026-09-02", expiryDate: "2027-09-02" };
(async () => {
  const inst = renderInstrument("dfy_authorized_representative_designation", ctx);
  const signed = await renderToBuffer(InstrumentPdf({ instrument: inst, signature: { signedName: "Andrew Ullmann", signedAt: new Date().toISOString(), ip: "203.0.113.7", userAgent: "Mozilla/5.0 (Macintosh) Safari/605.1.15", consentEventId: "6414f0fb-0000-4000-8000-000000000000" }, counterparty: "Accepted by Andrew Ullmann, an employee of Airgetlam Labs LLC (the operator of Candid), on September 2, 2026.", engagementId: "b15147fc-d1a6-4597-8101-a64a9c08cb65" }) as never);
  writeFileSync(`${out}/sample-signed.pdf`, signed);
  const form = await renderToBuffer(InstrumentPdf({ instrument: inst, signature: null, counterparty: null, engagementId: "b15147fc-d1a6-4597-8101-a64a9c08cb65" }) as never);
  writeFileSync(`${out}/sample-print.pdf`, form);
  console.log("wrote", `${out}/sample-signed.pdf`, signed.length, "bytes ·", `${out}/sample-print.pdf`, form.length, "bytes");
})();
