/**
 * S323 — INDEXNOW KEY FIXTURE (pure, offline, CI-wired).
 *
 * IndexNow ownership depends on three artifacts agreeing EXACTLY:
 *
 *   1. `src/lib/seo/indexnow.ts`      — the constant
 *   2. `public/<key>.txt`             — the hosted proof (filename AND contents)
 *   3. `src/middleware.ts`            — the allowlist entries that make it reachable
 *
 * Every way they can drift fails SILENTLY. A renamed or re-generated key
 * leaves a stale file; dropping the middleware entry makes the path 307 to the
 * landing page, which answers **HTTP 200 with HTML** — so an uptime-style
 * check passes while the engines quietly stop accepting submissions. Nothing
 * appears in our logs, because nothing of ours ran.
 *
 * This fixture is the only thing standing between that and a fix-it-in-three-
 * weeks discovery. It asserts the artifacts by reading them, not by trusting
 * that whoever edited one remembered the other two.
 *
 * Offline: filesystem reads only. No DB, no network, no env.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { INDEXNOW_KEY, INDEXNOW_KEY_PATH } from "@/lib/seo/indexnow";

const fails: string[] = [];
let pass = 0;

function check(label: string, ok: boolean): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fails.push(label);
    console.log(`  ✗ ${label}`);
  }
}

const ROOT = process.cwd();
const keyFile = join(ROOT, "public", `${INDEXNOW_KEY}.txt`);
const middleware = readFileSync(join(ROOT, "src/middleware.ts"), "utf8");

console.log("— the key itself —");
check("key is 64 lowercase hex chars", /^[0-9a-f]{64}$/.test(INDEXNOW_KEY));
check("key path is the key plus .txt at the root", INDEXNOW_KEY_PATH === `/${INDEXNOW_KEY}.txt`);

console.log("— the hosted proof —");
check("public/<key>.txt exists", existsSync(keyFile));
check(
  "its contents are exactly the key",
  existsSync(keyFile) && readFileSync(keyFile, "utf8").trim() === INDEXNOW_KEY,
);

console.log("— reachability (the silent-failure guard) —");
// Both middleware lists must reference the CONSTANT. Matching the literal
// string instead would let someone paste a stale key and still go green.
check(
  "middleware imports the shared constant",
  /import\s*\{[^}]*INDEXNOW_KEY_PATH[^}]*\}\s*from\s*"@\/lib\/seo\/indexnow"/.test(middleware),
);
check(
  "the auth bypass allows the key path",
  /pathname === INDEXNOW_KEY_PATH/.test(middleware),
);
check(
  "the key path is excluded from pageview counting",
  /NON_PAGE_FILES[\s\S]{0,600}INDEXNOW_KEY_PATH/.test(middleware),
);
check(
  "no hardcoded copy of the key outside the constant module",
  !new RegExp(INDEXNOW_KEY).test(middleware),
);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.error("FAILED:", fails.join(" | "));
  process.exit(1);
}
