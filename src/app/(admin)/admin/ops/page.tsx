import { readFileSync } from "node:fs";
import { join } from "node:path";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";

// Renders the canonical Admin Operations Manual (docs/admin-operations.md) as
// styled Candid prose. Sits behind the admin gate via the (admin) layout.
//
// Heading anchors come from rehype-slug, so every page's "Ops" deep-link
// (/admin/ops#<opsSlug>, defined in src/config/admin-nav.ts) resolves to its
// section. `scripts/check-admin-ops-anchors.mjs` guards that mapping.
// Styling is scoped via `.admin-ops-prose` in globals.css (single source; no
// per-element overrides to keep out of react-markdown's node-prop weeds).

function loadManual(): string {
  return readFileSync(join(process.cwd(), "docs/admin-operations.md"), "utf8");
}

export default function AdminOpsPage() {
  const manual = loadManual();
  return (
    <div className="admin-ops-prose mx-auto max-w-3xl">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]}>
        {manual}
      </Markdown>
    </div>
  );
}
