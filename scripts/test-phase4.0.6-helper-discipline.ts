/**
 * Phase 4.0.6 Task 4.0.6-L Test C13.5 — helper discipline grep enforcement.
 *
 * Per Q-P4.0.6-1 LOCK v4 refinement: ALL upload + correction paths MUST route
 * through `commitUploadAndEvaluateCorroboration()` rather than calling
 * `evaluateCorroboration` / `applyPromotionEvent` directly.
 *
 * This test asserts every known write-path file imports the helper. New write
 * paths added in future Sessions MUST be added to REQUIRED_FILES below; CI fails
 * if a known write-path file is missing the import.
 *
 * Usage:
 *   npx tsx scripts/test-phase4.0.6-helper-discipline.ts
 *
 * Adds this assertion to the Phase 4.0.6 pre-merge gate. Combine with the
 * SQL smoke tests at scripts/test-phase4.0.6-promotion-event.sql for full
 * Phase 4.0.6 verification.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const TAG = "[phase4.0.6-discipline]";

/**
 * Files that route user-side data writes to insurance_plans /
 * plan_covered_services with canonical_plan_id linkage. Each MUST import
 * commitUploadAndEvaluateCorroboration so canonical promotion events fire
 * post-commit.
 *
 * To add a new write-path file: implement the helper call, then add the path
 * here. CI will then enforce the discipline.
 */
const REQUIRED_FILES: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: "src/lib/plan/process-plan.ts",
    reason: "SBC + plan-doc upload pipeline; main canonical-feeding write path",
  },
  {
    path: "src/lib/plan/process-eoc.ts",
    reason: "EOC upload pipeline; secondary canonical-feeding write path",
  },
];

const REQUIRED_IMPORT = "commitUploadAndEvaluateCorroboration";
const REQUIRED_HELPER_MODULE = "@/lib/parser/commit-and-evaluate";

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`${TAG} FAIL ${label}`);
  }
}

const repoRoot = resolve(__dirname, "..");

console.log(`${TAG} starting C13.5 helper-discipline assertion`);
console.log(`${TAG} required helper: ${REQUIRED_IMPORT} from ${REQUIRED_HELPER_MODULE}`);
console.log(`${TAG} known write-path files: ${REQUIRED_FILES.length}`);

for (const { path, reason } of REQUIRED_FILES) {
  const fullPath = resolve(repoRoot, path);
  const exists = existsSync(fullPath);
  assert(exists, `C13.5 ${path} exists`);
  if (!exists) continue;

  const content = readFileSync(fullPath, "utf-8");
  const hasImport = content.includes(REQUIRED_IMPORT);
  assert(
    hasImport,
    `C13.5 ${path} imports ${REQUIRED_IMPORT} (${reason})`,
  );

  const hasHelperCall = content.match(/commitUploadAndEvaluateCorroboration\s*\(/);
  assert(
    !!hasHelperCall,
    `C13.5 ${path} invokes ${REQUIRED_IMPORT}() at least once`,
  );

  const hasSourceModule = content.includes(REQUIRED_HELPER_MODULE);
  assert(
    hasSourceModule,
    `C13.5 ${path} imports from ${REQUIRED_HELPER_MODULE}`,
  );
}

// Also verify that direct calls to applyPromotionEvent / evaluateCorroboration
// happen ONLY from the helper module + correction-challenge.ts (which is the
// challenge state machine that legitimately needs direct apply access).
const ALLOWED_DIRECT_CALLERS = new Set([
  "src/lib/parser/commit-and-evaluate.ts",
  "src/lib/parser/correction-challenge.ts",
  "src/lib/parser/promotion-event.ts", // self-export; module containing the function
  "src/lib/parser/corroboration-evaluator.ts", // self-export
  "scripts/test-phase4.0.6-helper-discipline.ts", // this file
]);

import { execSync } from "node:child_process";
let directCallerScan: string;
try {
  directCallerScan = execSync(
    `grep -rln "applyPromotionEvent\\|evaluateCorroboration" ${repoRoot}/src ${repoRoot}/scripts 2>/dev/null || true`,
    { encoding: "utf-8" },
  );
} catch {
  directCallerScan = "";
}
const directCallerFiles = directCallerScan
  .split("\n")
  .map((p) => p.trim())
  .filter((p) => p.length > 0)
  .map((p) => p.replace(`${repoRoot}/`, ""));

for (const file of directCallerFiles) {
  if (ALLOWED_DIRECT_CALLERS.has(file)) continue;
  // Files that import the helper but don't call applyPromotionEvent / evaluateCorroboration
  // directly are fine; we only fail if an unknown file BOTH appears in the grep result
  // AND uses the names directly (not just via re-export).
  const fullPath = resolve(repoRoot, file);
  if (!existsSync(fullPath)) continue;
  const content = readFileSync(fullPath, "utf-8");
  // Check for direct invocation pattern: applyPromotionEvent( or evaluateCorroboration(
  // (excludes type-only references).
  const hasDirectCall = /\b(applyPromotionEvent|evaluateCorroboration)\s*\(/.test(content);
  assert(
    !hasDirectCall,
    `C13.5 ${file} should not call applyPromotionEvent / evaluateCorroboration directly — route through commitUploadAndEvaluateCorroboration helper instead`,
  );
}

console.log(
  `${TAG} done — passed=${passed} failed=${failed} (write-path files=${REQUIRED_FILES.length}, scanned=${directCallerFiles.length})`,
);

if (failed > 0) {
  process.exit(1);
}
