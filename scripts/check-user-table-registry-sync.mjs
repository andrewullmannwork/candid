/**
 * scripts/check-user-table-registry-sync.mjs — B9 B1 CI guard (S185 B1.2).
 *
 * Asserts the ESLint ban-list (USER_OWNED_TABLES in eslint.config.mjs) stays
 * byte-identical to the userScoped layer's registry (DIRECT_USER_OWNED_TABLES +
 * PARENT_JOIN_TABLES in src/lib/security/user-scoped.ts). Drift in EITHER
 * direction is a real defect:
 *   - in the layer but NOT lint-banned → an un-guarded user table (silent IDOR surface)
 *   - lint-banned but NOT in the layer → a false lint error (no layer path to satisfy it)
 *
 * This repo has no test runner (CI = eslint + tsc + build only), so the contract
 * runs as a standalone CI step:  `npx tsx scripts/check-user-table-registry-sync.mjs`.
 * Authored as .mjs (not in the tsconfig include globs) so importing eslint.config.mjs
 * here never drags its untyped rule callbacks into `tsc --noEmit`. Exits 1 on
 * mismatch with a precise diff; exits 0 in sync.
 */
import {
  DIRECT_USER_OWNED_TABLES,
  PARENT_JOIN_TABLES,
} from "../src/lib/security/user-scoped";
import { USER_OWNED_TABLES } from "../eslint.config.mjs";

const layer = new Set([
  ...DIRECT_USER_OWNED_TABLES,
  ...Object.keys(PARENT_JOIN_TABLES),
]);
const lint = new Set(USER_OWNED_TABLES);

const inLayerNotLint = [...layer].filter((t) => !lint.has(t)).sort();
const inLintNotLayer = [...lint].filter((t) => !layer.has(t)).sort();

if (inLayerNotLint.length === 0 && inLintNotLayer.length === 0) {
  console.log(
    `✓ user-table registry in sync (${layer.size} tables: ` +
      `${DIRECT_USER_OWNED_TABLES.length} direct + ` +
      `${Object.keys(PARENT_JOIN_TABLES).length} parent-join).`,
  );
  process.exit(0);
}

console.error(
  "✗ user-table registry DRIFT — eslint.config.mjs USER_OWNED_TABLES and " +
    "src/lib/security/user-scoped.ts disagree:",
);
if (inLayerNotLint.length > 0) {
  console.error(
    `  In layer but NOT lint-banned (UN-GUARDED user table → IDOR surface): ${inLayerNotLint.join(", ")}`,
  );
}
if (inLintNotLayer.length > 0) {
  console.error(
    `  Lint-banned but NOT in layer (false lint error → no layer path): ${inLintNotLayer.join(", ")}`,
  );
}
console.error(
  "Fix: keep USER_OWNED_TABLES === DIRECT_USER_OWNED_TABLES + Object.keys(PARENT_JOIN_TABLES).",
);
process.exit(1);
