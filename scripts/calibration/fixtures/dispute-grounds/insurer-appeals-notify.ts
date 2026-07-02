/**
 * insurer-appeals-notify — formatter unit fixture (dispute-letters v2 S3).
 *
 * Asserts the Slack Block Kit payload for an appeals-address proposal has the right
 * shape, clear admin instructions (Accept/Reject → what each does), and the
 * /admin/insurer-appeals link. Pure (no network). The send itself is verified by a
 * real-fire check, not here.
 *
 * Run: npx tsx scripts/calibration/fixtures/dispute-grounds/insurer-appeals-notify.ts
 */
import {
  formatInsurerAppealsProposalSlack,
  formatAppealsAddressOneLine,
  type InsurerAppealsProposalPayload,
} from "../../../../src/lib/disputes/insurer-appeals-notify";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  ${String(got).slice(0, 160)}` : ""}`);
}

// ── formatAppealsAddressOneLine ──────────────────────────────────────────────
check("address: null → 'none on file'", formatAppealsAddressOneLine(null).includes("none on file"));
check(
  "address: full parts render one-line with phone",
  formatAppealsAddressOneLine({ addressLine1: "1 Appeals Way", addressLine2: "Ste 200", city: "Hartford", state: "CT", postalCode: "06101", phone: "(800) 555-1212" }) ===
    "1 Appeals Way, Ste 200, Hartford, CT 06101 · (800) 555-1212",
);
check(
  "address: partial (no phone / no line2) omits cleanly",
  formatAppealsAddressOneLine({ addressLine1: "PO Box 5", city: "Newark", state: "NJ", postalCode: "07101" }) === "PO Box 5, Newark, NJ 07101",
);

// ── formatInsurerAppealsProposalSlack ────────────────────────────────────────
const payload: InsurerAppealsProposalPayload = {
  insurerName: "Sample Health Plan",
  source: "user_correction",
  current: null,
  proposed: { addressLine1: "1 Appeals Way", city: "Hartford", state: "CT", postalCode: "06101" },
};
const msg = formatInsurerAppealsProposalSlack(payload);
const json = JSON.stringify(msg);

check("fallback text names the insurer", String(msg.text).includes("Sample Health Plan"), msg.text);
check("has a header block 'review needed'", json.includes('"type":"header"') && json.toLowerCase().includes("review needed"));
check("surfaces the insurer name field", json.includes("*Insurer:*") && json.includes("Sample Health Plan"));
check("surfaces the source label (user correction)", json.includes("User correction"));
check("current=null renders 'none on file'", json.includes("none on file"));
check("surfaces the proposed address", json.includes("1 Appeals Way"));
check("instruction: Accept = shared catalog, all users", json.includes("Accept") && json.includes("shared insurer catalog") && json.includes("all users"));
check("instruction: Reject keeps current", json.includes("Reject") && json.includes("keeps the current"));
check("instruction: submitter's own letter unaffected", json.toLowerCase().includes("submitter's own letter"));
check("action button links to the admin queue", json.includes("/admin/insurer-appeals"));

// doc_extraction source label
check(
  "doc_extraction source label",
  JSON.stringify(formatInsurerAppealsProposalSlack({ ...payload, source: "doc_extraction" })).includes("Document-extraction conflict"),
);

// current present → renders the current address (not 'none on file')
const withCurrent = JSON.stringify(
  formatInsurerAppealsProposalSlack({ ...payload, current: { addressLine1: "9 Old Rd", city: "Trenton", state: "NJ", postalCode: "08600" } }),
);
check("current present → renders current address", withCurrent.includes("9 Old Rd") && !withCurrent.includes("none on file"));

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\ninsurer-appeals-notify fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");
