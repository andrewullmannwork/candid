/**
 * IndexNow key — the one definition.
 *
 * IndexNow proves domain ownership by having you host the key as a plain-text
 * file at `<host>/<key>.txt`, so this value is PUBLIC BY DESIGN and committed
 * on purpose. It is not a secret and must never be treated as one.
 *
 * WHY A SHARED MODULE. The key otherwise appears in three places that must
 * agree exactly — the filename under `public/`, the middleware bypass, and the
 * submission payload — and the failure when they drift is SILENT: the engines
 * simply stop accepting submissions, with nothing in our logs. One constant,
 * two importers, and a fixture that asserts the file on disk matches.
 *
 * THE MIDDLEWARE ENTRY IS LOAD-BEARING. `src/middleware.ts` matches every path
 * except `_next/*` and `favicon.ico`, and auth-walls anything not explicitly
 * allowed — so a file sitting in `public/` is NOT reachable by default. It
 * 307s to the landing page, which returns HTTP 200 with HTML, so a naive check
 * ("did it respond?") passes while key validation fails. Verified locally:
 * `llms.txt` is allowlisted and serves 200; this file 307'd until it was added
 * to the same two lists.
 */

/** 64 hex chars. Public — this is how IndexNow verifies we own the domain. */
export const INDEXNOW_KEY =
  "96f1475370b0cf05cf7531afb2dfd18cfa2b1556e18d4cc568ff6e4498bf3450";

/** Where the key file is served from. Must match a real file in `public/`. */
export const INDEXNOW_KEY_PATH = `/${INDEXNOW_KEY}.txt`;
