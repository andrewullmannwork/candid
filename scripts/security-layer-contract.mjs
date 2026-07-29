/**
 * scripts/security-layer-contract.mjs — B9 B1 layer contract (S185 B1.2).
 *
 * Mock-Supabase unit contract for the userScoped ownership layer. The repo has
 * no test runner (CI = eslint + tsc + build), so this runs as a CI step:
 *   `npx tsx scripts/security-layer-contract.mjs`
 *
 * Proves the SECURITY properties that make the B1.2 codemod safe — independent of
 * the database: ownership is injected/enforced by the layer, and the new child
 * primitives are scoped-by-construction + fail-closed. Exits 1 on any failure.
 */
import {
  userScoped,
  adminScoped,
  selectOwnedChildren,
  selectOwnedParentIds,
  updateOwnedChildren,
  upsertOwnedChildren,
  deleteOwnedChildren,
} from "../src/lib/security/user-scoped";

// In-memory dataset: u1 owns c1 (lines li1,li2); u2 owns c2 (line li3).
const DB = {
  claims: [
    { id: "c1", user_id: "u1" },
    { id: "c2", user_id: "u2" },
  ],
  claim_line_items: [
    { id: "li1", claim_id: "c1", metadata: { a: 1 } },
    { id: "li2", claim_id: "c1", metadata: { b: 2 } },
    { id: "li3", claim_id: "c2", metadata: { c: 3 } },
  ],
  dispute_outcomes: [{ id: "d1", user_id: "u1" }],
  // adminScoped fixtures: admin1 is an admin, u1 is not; benefit_corrections
  // owned by two different users (admin must read BOTH; a user only their own).
  users: [
    { id: "u1", is_admin: false },
    { id: "admin1", is_admin: true },
  ],
  benefit_corrections: [
    { id: "bc1", user_id: "u1" },
    { id: "bc2", user_id: "u2" },
  ],
};
const writes = [];
const inserts = [];
const upserts = [];
const deletes = [];

class QB {
  constructor(table) {
    this.table = table;
    this.op = "select";
    this.filters = [];
  }
  select(cols) {
    this.op = this.op === "select" ? "select" : this.op;
    this.cols = cols;
    return this;
  }
  update(values) {
    this.op = "update";
    this.values = values;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  insert(rows) {
    this.op = "insert";
    this.rows = rows;
    return this;
  }
  upsert(rows, options) {
    this.op = "upsert";
    this.rows = rows;
    this.onConflict = options?.onConflict;
    return this;
  }
  eq(col, val) {
    this.filters.push(["eq", col, val]);
    return this;
  }
  in(col, vals) {
    this.filters.push(["in", col, vals]);
    return this;
  }
  order() {
    return this;
  }
  _rows() {
    let rows = (DB[this.table] ?? []).slice();
    for (const f of this.filters) {
      if (f[0] === "eq") rows = rows.filter((r) => r[f[1]] === f[2]);
      if (f[0] === "in") rows = rows.filter((r) => f[2].includes(r[f[1]]));
    }
    return rows;
  }
  _run() {
    if (this.op === "insert") {
      const rows = Array.isArray(this.rows) ? this.rows : [this.rows];
      for (const r of rows) inserts.push({ table: this.table, row: r });
      return { data: null, error: null };
    }
    if (this.op === "upsert") {
      const rows = Array.isArray(this.rows) ? this.rows : [this.rows];
      for (const r of rows) upserts.push({ table: this.table, row: r, onConflict: this.onConflict });
      return { data: null, error: null };
    }
    const rows = this._rows();
    if (this.op === "update") {
      for (const r of rows) writes.push({ table: this.table, id: r.id, values: this.values });
      return { data: null, error: null };
    }
    if (this.op === "delete") {
      for (const r of rows) deletes.push({ table: this.table, id: r.id, filters: this.filters });
      return { data: null, error: null };
    }
    return { data: rows, error: null };
  }
  then(resolve) {
    resolve(this._run());
  }
  maybeSingle() {
    const r = this._rows();
    return Promise.resolve({ data: r[0] ?? null, error: null });
  }
  single() {
    const r = this._rows();
    return Promise.resolve({
      data: r[0] ?? null,
      error: r.length ? null : { code: "PGRST116" },
    });
  }
}
const client = { from: (t) => new QB(t) };

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}`);
    failures += 1;
  }
}
async function throws(fn) {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

console.log("B9 B1 security-layer contract:");

// 1) selectOwnedParentIds — owner resolves; foreign yields empty.
check(
  "selectOwnedParentIds: u1 owns c1",
  (await selectOwnedParentIds(client, "u1", "claims", ["c1", "c2"])).has("c1") &&
    !(await selectOwnedParentIds(client, "u1", "claims", ["c1", "c2"])).has("c2"),
);

// 2) selectOwnedChildren — owner gets children; foreign parent → [] (closure).
const ownerLines = await selectOwnedChildren(client, "u1", "claim_line_items", ["c1"]);
check("selectOwnedChildren: u1/c1 → li1+li2", ownerLines.length === 2);
const foreignLines = await selectOwnedChildren(client, "u2", "claim_line_items", ["c1"]);
check("selectOwnedChildren: u2/c1 (foreign) → [] (closure)", foreignLines.length === 0);

// 3) updateOwnedChildren — owner writes all (op-equivalent count).
writes.length = 0;
const okRes = await updateOwnedChildren(client, "u1", "claim_line_items", "c1", [
  { id: "li1", values: { metadata: { x: 1 } } },
  { id: "li2", values: { metadata: { y: 2 } } },
]);
check("updateOwnedChildren: owner u1/c1 → updated=2", okRes.updated === 2);
check(
  "updateOwnedChildren: owner wrote exactly li1+li2 (fk-scoped to c1)",
  writes.length === 2 && writes.map((w) => w.id).sort().join(",") === "li1,li2",
);

// 4) updateOwnedChildren — foreign parent → 0 writes (closure).
writes.length = 0;
const foreignRes = await updateOwnedChildren(client, "u2", "claim_line_items", "c1", [
  { id: "li1", values: { metadata: { hacked: true } } },
]);
check("updateOwnedChildren: foreign u2/c1 → updated=0", foreignRes.updated === 0);
check("updateOwnedChildren: foreign parent wrote NOTHING (closure)", writes.length === 0);

// 5) updateOwnedChildren — belt-and-suspenders: a child id from a DIFFERENT claim
//    (li3 under c2) is not written even though the caller owns parent c1.
writes.length = 0;
await updateOwnedChildren(client, "u1", "claim_line_items", "c1", [
  { id: "li3", values: { metadata: { hacked: true } } },
]);
check("updateOwnedChildren: cross-claim li3 under c1 → 0 actual writes (fk guard)", writes.length === 0);

// 6) Fail-closed — empty userId throws (never scopes on a falsy owner).
check("updateOwnedChildren: empty userId THROWS", await throws(() => updateOwnedChildren(client, "", "claim_line_items", "c1", [{ id: "li1", values: {} }])));
check("selectOwnedChildren: empty userId THROWS", await throws(() => selectOwnedChildren(client, "", "claim_line_items", ["c1"])));
check("userScoped: empty userId THROWS", await throws(async () => userScoped(client, "")));

// 7) userScoped.table — select injects user_id; insert stamps user_id.
const scoped = await userScoped(client, "u1").table("dispute_outcomes").select("*").eq("id", "d1").single();
check("userScoped.select: u1 reads own d1", scoped.data?.id === "d1");
const scopedForeign = await userScoped(client, "u2").table("dispute_outcomes").select("*").eq("id", "d1").single();
check("userScoped.select: u2 reading d1 → null (scoped closure)", scopedForeign.data === null);
inserts.length = 0;
await userScoped(client, "u1").table("dispute_outcomes").insert({ foo: "bar" });
check("userScoped.insert: stamps user_id=u1 (overrides caller)", inserts.length === 1 && inserts[0].row.user_id === "u1");

// 8) updateOwnedChildren — unregistered child table fails closed.
check("updateOwnedChildren: non-parent-join table THROWS", await throws(() => updateOwnedChildren(client, "u1", "documents", "c1", [{ id: "x", values: {} }])));

// 9) userScoped.upsert — stamps user_id (overrides caller) + requires user_id in onConflict.
upserts.length = 0;
await userScoped(client, "u1")
  .table("dispute_outcomes")
  .upsert({ id: "d1", user_id: "u2", foo: "x" }, { onConflict: "user_id" });
check(
  "userScoped.upsert: stamps user_id=u1 (overrides caller u2)",
  upserts.length === 1 && upserts[0].row.user_id === "u1",
);
check(
  "userScoped.upsert: onConflict missing user_id THROWS",
  await throws(() =>
    userScoped(client, "u1").table("dispute_outcomes").upsert({ foo: "x" }, { onConflict: "id" }),
  ),
);

// 10) upsertOwnedChildren — owner upserts (fk stamped); foreign parent → 0 (closure); guards.
upserts.length = 0;
const upOk = await upsertOwnedChildren(
  client,
  "u1",
  "claim_line_items",
  "c1",
  [{ id: "li1", metadata: { z: 1 } }],
  { onConflict: "claim_id,id" },
);
check(
  "upsertOwnedChildren: owner u1/c1 → upserted=1 + fk stamped to c1",
  upOk.upserted === 1 && upserts.length === 1 && upserts[0].row.claim_id === "c1",
);
upserts.length = 0;
const upForeign = await upsertOwnedChildren(client, "u2", "claim_line_items", "c1", [{ id: "li1" }], {
  onConflict: "claim_id,id",
});
check(
  "upsertOwnedChildren: foreign u2/c1 → upserted=0 (closure)",
  upForeign.upserted === 0 && upserts.length === 0,
);
check(
  "upsertOwnedChildren: onConflict missing fk THROWS",
  await throws(() =>
    upsertOwnedChildren(client, "u1", "claim_line_items", "c1", [{ id: "li1" }], { onConflict: "id" }),
  ),
);
check(
  "upsertOwnedChildren: empty userId THROWS",
  await throws(() =>
    upsertOwnedChildren(client, "", "claim_line_items", "c1", [{ id: "li1" }], {
      onConflict: "claim_id,id",
    }),
  ),
);

// 11) adminScoped — admin-authority cross-user access. Reads users.is_admin
//     (fail-closed): admin → un-scoped builder (sees ALL users' rows, NO user_id
//     filter); non-admin / unknown / empty → throws. (S192 B1.2 — corrections admin.)
const adminRows = await (await adminScoped(client, "admin1"))
  .table("benefit_corrections")
  .select("*");
check(
  "adminScoped: admin reads cross-user (bc1+bc2, NO user_id filter)",
  Array.isArray(adminRows.data) && adminRows.data.length === 2,
);
check(
  "adminScoped: non-admin (u1) THROWS (fail-closed)",
  await throws(() => adminScoped(client, "u1")),
);
check(
  "adminScoped: unknown user THROWS (fail-closed)",
  await throws(() => adminScoped(client, "ghost")),
);
check(
  "adminScoped: empty userId THROWS",
  await throws(() => adminScoped(client, "")),
);

// 11) deleteOwnedChildren (S292 4C) — owner deletes fk-scoped; foreign parent
// deletes NOTHING; an empty match is refused rather than wiping the parent.
deletes.length = 0;
const delOk = await deleteOwnedChildren(client, "u1", "claim_line_items", "c1", [{ id: "li1" }]);
check(
  "deleteOwnedChildren: owner u1/c1 → deleted=1",
  delOk.deleted === 1 && deletes.length === 1,
);
check(
  "deleteOwnedChildren: delete is fk-pinned to the verified parent",
  deletes[0].filters.some(([op, col, val]) => op === "eq" && col === "claim_id" && val === "c1"),
);
deletes.length = 0;
const delForeign = await deleteOwnedChildren(client, "u2", "claim_line_items", "c1", [{ id: "li1" }]);
check(
  "deleteOwnedChildren: foreign u2/c1 → deleted=0 and NOTHING removed (closure)",
  delForeign.deleted === 0 && deletes.length === 0,
);
deletes.length = 0;
await deleteOwnedChildren(client, "u1", "claim_line_items", "c1", [{ id: "li3" }]);
check(
  // li3 belongs to c2. The statement runs (so the count is not an error signal,
  // same as updateOwnedChildren) but the fk pin means it matches NO row — the
  // property that matters is that nothing was actually removed.
  "deleteOwnedChildren: cross-claim li3 under c1 removes NOTHING (fk guard)",
  deletes.length === 0,
);
check(
  "deleteOwnedChildren: EMPTY match THROWS (would delete every child row)",
  await throws(() => deleteOwnedChildren(client, "u1", "claim_line_items", "c1", [{}])),
);
check(
  "deleteOwnedChildren: empty userId THROWS",
  await throws(() => deleteOwnedChildren(client, "", "claim_line_items", "c1", [{ id: "li1" }])),
);
check(
  "deleteOwnedChildren: non-parent-join table THROWS",
  await throws(() => deleteOwnedChildren(client, "u1", "documents", "c1", [{ id: "x" }])),
);

if (failures === 0) {
  console.log("✓ security-layer contract PASSED");
  process.exit(0);
}
console.error(`✗ security-layer contract FAILED (${failures})`);
process.exit(1);
