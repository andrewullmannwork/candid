import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Archived diagnostic snapshots — frozen one-off scripts retained for
    // historical traceability per S96 doc-organization convention. Linting
    // these would force perpetual cleanup of code that intentionally captures
    // a moment-in-time investigation.
    "scripts/findings/**",
  ]),
]);

export default eslintConfig;
