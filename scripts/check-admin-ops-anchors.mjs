#!/usr/bin/env node
// Guards the admin ops-manual deep-links.
//
// The admin sidebar + each page's "Ops" link read `opsSlug` from
// src/config/admin-nav.ts and deep-link to /admin/ops#<opsSlug>. The ops page
// renders heading anchors from docs/admin-operations.md via rehype-slug, so a
// renamed or missing section heading would silently break a page's Ops link.
// This check turns that into a loud failure.
//
// Run: node scripts/check-admin-ops-anchors.mjs   (wire into CI / pre-PR lint)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Mirror of rehype-slug's github-slugger output for the clean headings we author
// (single spaces, no decorative punctuation): lowercase, non-alphanumerics → "-".
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const registry = readFileSync(join(root, "src/config/admin-nav.ts"), "utf8");
const expected = [...registry.matchAll(/opsSlug:\s*"([^"]+)"/g)].map((m) => m[1]);

const manual = readFileSync(join(root, "docs/admin-operations.md"), "utf8");
const headingSlugs = new Set(
  [...manual.matchAll(/^#{2,3}\s+(.+?)\s*$/gm)].map((m) => slugify(m[1])),
);

const missing = expected.filter((slug) => !headingSlugs.has(slug));

if (missing.length) {
  console.error(
    "✖ admin ops-anchor check FAILED — these registry opsSlugs have no matching\n" +
      "  section heading in docs/admin-operations.md:",
  );
  for (const s of missing) console.error("  - #" + s);
  console.error(
    "\nFix: rename the section heading so it slugifies to the opsSlug, or update the\n" +
      "opsSlug in src/config/admin-nav.ts. (Anchors come from rehype-slug on the heading text.)",
  );
  process.exit(1);
}

console.log(
  `✓ admin ops-anchor check passed — all ${expected.length} page anchors resolve in docs/admin-operations.md`,
);
