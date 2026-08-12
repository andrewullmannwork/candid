// S311 §2.1 — one-shot codemod: add the void-letter write guard to the 12
// uniform dispute-row writer routes (rerun-audit is hand-edited separately).
// Idempotent: skips a file that already imports driftMachineryApplies.
import fs from "fs";

const ROUTES = [
  "attest-service",
  "bind-canonical",
  "checklist",
  "clear-coverage-diff",
  "collector-contact",
  "confirm-patient-identity",
  "confirm-same-plan",
  "deadline-inputs",
  "dismiss-wrong-year-banner",
  "insurer-address",
  "repin",
  "escalate",
];

const GUARD = `
  // S311 (tree §2.1) — a VOID letter is a read-only exhibit (S308's rule;
  // this route was reachable from a cancelled letter's page and its write
  // would have moved the frozen row's updated_at). Sent letters stay
  // writable — their metadata is the knowledge layer follow-ups read.
  // One rule, stated once: driftMachineryApplies === false ⇔ void.
  if (
    !driftMachineryApplies(
      (dispute.status as string | null) ?? null,
      dispute.sent_at ? new Date(dispute.sent_at as string) : null,
    )
  ) {
    return NextResponse.json({ error: "letter_void" }, { status: 409 });
  }
`;

for (const r of ROUTES) {
  const f = `src/app/api/disputes/[disputeId]/${r}/route.ts`;
  let src = fs.readFileSync(f, "utf8");
  if (src.includes("driftMachineryApplies")) {
    console.log(`SKIP (already guarded): ${r}`);
    continue;
  }
  const orig = src;

  // 1. import — after the user-scoped import every route has
  src = src.replace(
    /(import \{[^}]*userScoped[^}]*\} from "@\/lib\/security\/user-scoped";)/,
    '$1\nimport { driftMachineryApplies } from "@/lib/disputes/evidence-fingerprint";',
  );

  // 2. widen the FIRST dispute_outcomes load select with status, sent_at
  src = src.replace(
    /(\.table\("dispute_outcomes"\)\s*\n\s*\.select\(\s*\n?\s*")([^"]*)(")/,
    (m, a, cols, c) => (cols.includes("status") ? m : a + cols + ", status, sent_at" + c),
  );

  // 3. guard after the dispute not-found block
  src = src.replace(
    /(return NextResponse\.json\(\s*\{ error: "Dispute not found" \},?\s*\{ status: 404 \},?\s*\);\s*\n\s*\}\n)/,
    "$1" + GUARD,
  );

  const importOk = src.includes('driftMachineryApplies } from "@/lib/disputes/evidence-fingerprint"');
  const selectOk = /\.table\("dispute_outcomes"\)\s*\n\s*\.select\(\s*\n?\s*"[^"]*status, sent_at/.test(src);
  const guardOk = src.includes('{ error: "letter_void" }');
  if (!importOk || !selectOk || !guardOk || src === orig) {
    console.log(`FAILED (${r}): import=${importOk} select=${selectOk} guard=${guardOk}`);
    continue;
  }
  fs.writeFileSync(f, src);
  console.log(`OK: ${r}`);
}
