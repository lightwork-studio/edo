import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AuthenticatedHistory,
  decodePullResponse,
  favoriteRecordId,
  type JsonObject,
  maxSyncEnvelopeBytes,
  type NegotiatedSync,
  negotiateHello,
  type Submission,
  type SyncWireError,
  syncScope,
} from "@edo/contract";
import { afterEach, beforeEach, expect, test } from "vitest";
import { applyRecordContent } from "../src/record-projection.ts";
import {
  InvalidSyncContent,
  openSyncStore as openValidatedSyncStore,
  type SyncStore,
  type SyncStoreOptions,
} from "../src/sync-store.ts";

let directory: string;
let filename: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "edo-sync-store-"));
  filename = join(directory, "account-sync.sqlite");
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

// These fixtures isolate SQLite and packet behavior from the application record projection.
function openSyncStore(
  path: string,
  options: SyncStoreOptions = { applyContent: ({ submitted }) => submitted },
): SyncStore {
  return openValidatedSyncStore(path, options);
}

function sessionFor(history: AuthenticatedHistory | null): NegotiatedSync {
  if (!history) throw new Error("Missing synthetic account history");
  const hello = negotiateHello({ releases: ["0.1"], features: ["write-records"] }, history);
  if (hello.status !== "ready") throw new Error("Could not negotiate synthetic session");
  return hello.session;
}

function put(
  id: string,
  submissionId: string,
  baseRevision: number | null,
  content: JsonObject,
): Submission {
  return { kind: "meal", op: "put", id, submissionId, baseRevision, content };
}

function remove(id: string, submissionId: string, baseRevision: number | null): Submission {
  return { kind: "meal", op: "delete", id, submissionId, baseRevision };
}

function mealContent(...itemIds: string[]): JsonObject {
  return { items: itemIds.map((id) => ({ id })) };
}

function candidateV1(db: DatabaseSync) {
  // Everything added in v2 belongs to the owner index and its upkeep.
  db.exec(`
    DROP TRIGGER sync_claim_inserted_meal_items;
    DROP TRIGGER sync_replace_updated_meal_items;
    DROP TRIGGER sync_release_deleted_meal_items;
    DROP TABLE sync_meal_item_owners;
    PRAGMA user_version = 1;
  `);
}

function push(store: SyncStore, session: NegotiatedSync, ...submissions: Submission[]) {
  return store.push(session.accountBinding, session, {
    ...syncScope(session),
    submissions,
  });
}

function pull(store: SyncStore, session: NegotiatedSync, cursor = 0, limit?: number) {
  const request = {
    ...syncScope(session),
    cursor,
    ...(limit !== undefined && { limit }),
  };
  const response = store.pull(session.accountBinding, session, request);
  return decodePullResponse(response, request, session);
}

function expectWireError(action: () => unknown, code: SyncWireError["code"]) {
  expect(action).toThrow(expect.objectContaining({ code }));
}

test("replays canonical receipt outcomes after reopening the store and reserves used IDs", () => {
  let firstResult: unknown;
  let oldConflict: unknown;
  {
    using store = openSyncStore(filename);
    const session = sessionFor(store.createAccount("alpha", "history-alpha"));
    if (process.platform !== "win32") expect(statSync(filename).mode & 0o777).toBe(0o600);
    firstResult = push(
      store,
      session,
      put("breakfast", "first", null, { name: "Oats", extra: { a: 1, b: 2 } }),
    );
    oldConflict = push(store, session, put("breakfast", "conflict", null, { name: "Toast" }));
    expect(oldConflict).toMatchObject({
      results: [{ status: "conflict", reason: "exists", current: { revision: 1 } }],
    });
    expect(
      push(store, session, put("breakfast", "update", 1, { name: "Porridge" })).results,
    ).toEqual([{ status: "accepted", submissionId: "update", revision: 2 }]);
  }
  {
    using store = openSyncStore(filename);
    const session = sessionFor(store.history("alpha"));
    expect(
      push(
        store,
        session,
        put("breakfast", "first", null, { extra: { b: 2, a: 1 }, name: "Oats" }),
      ),
    ).toEqual(firstResult);
    expect(push(store, session, put("breakfast", "conflict", null, { name: "Toast" }))).toEqual(
      oldConflict,
    );
    expect(
      push(store, session, put("breakfast", "first", null, { name: "Different" })).results,
    ).toMatchObject([{ status: "rejected", code: "submission-reused" }]);
    expect(push(store, session, put("breakfast", "same", 1, { name: "Porridge" })).results).toEqual(
      [{ status: "accepted", submissionId: "same", revision: 2 }],
    );
    expect(
      push(store, session, put("breakfast", "already-saved", 2, { name: "Porridge" })).results,
    ).toEqual([{ status: "accepted", submissionId: "already-saved", revision: 2 }]);
    expect(store.history("alpha")?.revision).toBe(2);
    expectWireError(
      () =>
        push(
          store,
          session,
          put("lunch", "new-meal", null, { name: "Soup" }),
          put("breakfast", "future", 3, { name: "Porridge" }),
        ),
      "cursor-reset",
    );
    expect(store.history("alpha")?.revision).toBe(2);
    expect(pull(store, session).changes.map((record) => record.revision)).toEqual([2]);
  }
});

test("uses current base revisions across connections and serves ordered pull pages", () => {
  using first = openSyncStore(filename);
  using second = openSyncStore(filename);
  const writer = sessionFor(first.createAccount("alpha", "history-alpha"));
  expect(push(first, writer, put("lunch", "first", null, { name: "Soup" })).results).toMatchObject([
    { status: "accepted", revision: 1 },
  ]);
  const concurrent = sessionFor(second.history("alpha"));
  expect(push(first, writer, put("lunch", "next", 1, { name: "Stew" })).results).toMatchObject([
    { status: "accepted", revision: 2 },
  ]);
  expect(
    push(second, concurrent, put("lunch", "stale", 1, { name: "Salad" })).results,
  ).toMatchObject([
    { status: "conflict", reason: "stale", current: { revision: 2, content: { name: "Stew" } } },
  ]);
  expect(
    push(second, concurrent, put("lunch", "rebase", 2, { name: "Salad" })).results,
  ).toMatchObject([{ status: "accepted", revision: 3 }]);

  push(
    first,
    writer,
    put("small-meal", "additional", null, {}),
    put("other-meal", "extra", null, {}),
  );
  const firstPage = pull(second, concurrent, 0, 2);
  const finalPage = pull(second, concurrent, firstPage.cursor, 2);
  expect(firstPage).toMatchObject({
    cursor: 4,
    hasMore: true,
    changes: [{ revision: 3 }, { revision: 4 }],
  });
  expect(finalPage).toMatchObject({ cursor: 5, hasMore: false, changes: [{ revision: 5 }] });
  expect(pull(first, writer, finalPage.cursor)).toMatchObject({
    cursor: 5,
    hasMore: false,
    changes: [],
  });
});

test("persists deletions and prevents a stale client from bringing back a tombstoned ID", () => {
  {
    using store = openSyncStore(filename);
    const session = sessionFor(store.createAccount("alpha", "history-alpha"));
    push(store, session, put("snack", "initial", null, { name: "Pear" }));
    expect(push(store, session, remove("snack", "delete", 1)).results).toMatchObject([
      { status: "accepted", revision: 2 },
    ]);
  }
  {
    using store = openSyncStore(filename);
    const session = sessionFor(store.history("alpha"));
    expect(
      push(store, session, put("snack", "recreate", null, { name: "Pear" })).results,
    ).toMatchObject([
      { status: "conflict", reason: "deleted", current: { state: "deleted", revision: 2 } },
    ]);
    expect(push(store, session, remove("snack", "repeat", 1)).results).toMatchObject([
      { status: "accepted", revision: 2 },
    ]);
    expectWireError(
      () => push(store, session, remove("snack", "future-delete", 3)),
      "cursor-reset",
    );
    expect(push(store, session, put("missing", "missing-base", 2, {})).results).toMatchObject([
      { status: "conflict", reason: "stale", current: null },
    ]);
    expect(
      push(store, session, remove("never-uploaded", "delete-never-uploaded", null)).results,
    ).toMatchObject([{ status: "accepted", revision: 3 }]);
    expect(pull(store, session)).toMatchObject({
      cursor: 3,
      changes: [
        { state: "deleted", id: "snack", revision: 2 },
        { state: "deleted", id: "never-uploaded", revision: 3 },
      ],
    });
  }
});

test("requires a record projector before creating sync storage", () => {
  expect(() => openValidatedSyncStore(filename, {} as SyncStoreOptions)).toThrow(
    /needs record validation/,
  );
});

test("rejects impossible base revisions for missing records before processing a batch", () => {
  using store = openSyncStore(filename);
  const session = sessionFor(store.createAccount("alpha", "history-alpha"));
  expectWireError(
    () => push(store, session, put("first", "add", null, {}), put("missing", "future", 1, {})),
    "cursor-reset",
  );
  expect(store.history("alpha")?.revision).toBe(0);
  expect(pull(store, session).changes).toEqual([]);
});

test("checks every claimed revision against the state before any write in the batch", () => {
  using store = openSyncStore(filename);
  const session = sessionFor(store.createAccount("alpha", "history-alpha"));
  push(store, session, put("a", "seed-a", null, { name: "A" }), put("b", "seed-b", null, {}));
  const moveA = put("a", "first-edit", 1, { name: "Updated" });
  const impossibleBase = put("a", "next-edit", 2, { name: "Updated" });
  expectWireError(() => push(store, session, moveA, impossibleBase), "cursor-reset");
  expect(store.history("alpha")?.revision).toBe(2);
  expect(pull(store, session).changes[0]).toMatchObject({
    id: "a",
    revision: 1,
    content: { name: "A" },
  });
});

test("rejects a tombstone whose record ID cannot fit a pull page", () => {
  using store = openSyncStore(filename);
  const session = sessionFor(store.createAccount("alpha", "history-alpha"));
  const id = "x".repeat(maxSyncEnvelopeBytes);
  expect(push(store, session, remove(id, "oversized", null)).results).toMatchObject([
    { status: "rejected", code: "invalid-content" },
  ]);
  expect(store.history("alpha")?.revision).toBe(0);
  expect(pull(store, session).changes).toEqual([]);
});

test("re-adds a favourite when the client has observed its tombstone", () => {
  using store = openSyncStore(filename, { applyContent: applyRecordContent });
  const session = sessionFor(store.createAccount("alpha", "history-alpha"));
  const content = { provider: "local", sourceId: "food-1" };
  const id = favoriteRecordId(content.provider, content.sourceId);
  const save = (submissionId: string, base: number | null): Submission => ({
    ...put(id, submissionId, base, content),
    kind: "favorite",
  });
  expect(push(store, session, save("first", null)).results).toMatchObject([{ revision: 1 }]);
  expect(
    push(store, session, { ...remove(id, "remove", 1), kind: "favorite" }).results,
  ).toMatchObject([{ revision: 2 }]);
  for (const base of [null, 1]) {
    expect(push(store, session, save(`stale-${base}`, base)).results).toMatchObject([
      { status: "conflict", reason: "deleted" },
    ]);
  }
  expect(push(store, session, save("re-add", 2)).results).toMatchObject([
    { status: "accepted", revision: 3 },
  ]);
  expect(pull(store, session).changes).toMatchObject([
    { state: "live", kind: "favorite", content },
  ]);
});

test("scopes record history, revisions, and receipts to the authenticated account", () => {
  using store = openSyncStore(filename);
  const alpha = sessionFor(store.createAccount("alpha", "shared-name"));
  const beta = sessionFor(store.createAccount("beta", "shared-name"));
  push(store, alpha, put("meal", "shared-id", null, { name: "Alpha" }));
  expect(push(store, beta, put("meal", "shared-id", null, { name: "Beta" })).results).toMatchObject(
    [{ status: "accepted", revision: 1 }],
  );
  expectWireError(
    () => store.pull("alpha", beta, { ...syncScope(beta), cursor: 0 }),
    "unauthorized",
  );
  expectWireError(
    () =>
      store.push("alpha", beta, {
        ...syncScope(beta),
        submissions: [put("meal", "disallowed", 1, {})],
      }),
    "unauthorized",
  );
  expectWireError(
    () =>
      store.push("alpha", alpha, {
        release: alpha.release,
        lineage: alpha.lineage,
        accountBinding: "beta",
        submissions: [put("meal", "disallowed", 1, {})],
      }),
    "account-changed",
  );
  const forged = sessionFor({
    accountBinding: "missing",
    lineage: "shared-name",
    revision: 0,
    restoredFrom: null,
  });
  expectWireError(() => pull(store, forged), "unauthorized");
  expect(pull(store, alpha).changes).toMatchObject([{ content: { name: "Alpha" } }]);
  expect(pull(store, beta).changes).toMatchObject([{ content: { name: "Beta" } }]);
});

test("claims items within one account until their owner edits or deletes the meal", () => {
  using store = openSyncStore(filename);
  using concurrent = openSyncStore(filename);
  const alpha = sessionFor(store.createAccount("alpha", "history-alpha"));
  const beta = sessionFor(store.createAccount("beta", "history-beta"));
  const firstMeal = mealContent("moving-item", "retained-item");
  expect(push(store, alpha, put("first", "initial", null, firstMeal)).results).toMatchObject([
    { status: "accepted", revision: 1 },
  ]);
  expect(push(store, beta, put("other-account", "initial", null, firstMeal)).results).toMatchObject(
    [{ status: "accepted", revision: 1 }],
  );
  expect(push(concurrent, alpha, put("first", "same", 1, firstMeal)).results).toMatchObject([
    { status: "accepted", revision: 1 },
  ]);
  push(store, alpha, put("second", "second-initial", null, mealContent("other-item")));

  const conflicting = put("second", "conflicting", 2, mealContent("free-item", "moving-item"));
  const rejected = push(concurrent, alpha, conflicting);
  expect(rejected.results).toMatchObject([{ status: "rejected", code: "invalid-content" }]);
  expect(
    push(store, alpha, put("third", "still-owned", null, mealContent("other-item"))).results,
  ).toMatchObject([{ status: "rejected", code: "invalid-content" }]);
  expect(
    push(
      store,
      alpha,
      put("third", "duplicate-in-meal", null, mealContent("free-item", "free-item")),
    ).results,
  ).toMatchObject([{ status: "rejected", code: "invalid-content" }]);
  expect(
    push(store, alpha, put("third", "unclaimed", null, mealContent("free-item"))).results,
  ).toMatchObject([{ status: "accepted", revision: 3 }]);
  expect(
    push(store, alpha, put("first", "releases-item", 1, mealContent("retained-item"))).results,
  ).toMatchObject([{ status: "accepted", revision: 4 }]);
  expect(push(concurrent, alpha, conflicting)).toEqual(rejected);
  expect(
    push(concurrent, alpha, put("second", "move-item", 2, mealContent("moving-item"))).results,
  ).toMatchObject([{ status: "accepted", revision: 5 }]);
  push(store, alpha, remove("second", "delete-second", 5));
  expect(
    push(
      concurrent,
      alpha,
      put("third", "moves-after-delete", 3, mealContent("free-item", "moving-item")),
    ).results,
  ).toMatchObject([{ status: "accepted", revision: 7 }]);
  expect(pull(store, beta).changes).toMatchObject([{ id: "other-account", content: firstMeal }]);
});

test("upgrades a v1 file without changing revisions or terminal receipts", () => {
  const submitted = put("first", "initial", null, mealContent("saved-item"));
  let receipt: unknown;
  {
    using store = openSyncStore(filename);
    const alpha = sessionFor(store.createAccount("alpha", "history-alpha"));
    const beta = sessionFor(store.createAccount("beta", "history-beta"));
    receipt = push(store, alpha, submitted);
    push(store, alpha, put("deleted", "deleted-put", null, mealContent("released-item")));
    push(store, alpha, remove("deleted", "deleted-remove", 2));
    push(store, beta, put("beta-meal", "beta-put", null, mealContent("saved-item")));
  }
  {
    using old = new DatabaseSync(filename);
    candidateV1(old);
  }
  using upgraded = openSyncStore(filename);
  using inspected = new DatabaseSync(filename);
  const alpha = sessionFor(upgraded.history("alpha"));
  expect(alpha.revision).toBe(3);
  expect(inspected.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
  expect(
    inspected.prepare("SELECT * FROM sync_meal_item_owners ORDER BY account_binding").all(),
  ).toEqual([
    { account_binding: "alpha", item_id: "saved-item", meal_id: "first" },
    { account_binding: "beta", item_id: "saved-item", meal_id: "beta-meal" },
  ]);
  expect(push(upgraded, alpha, submitted)).toEqual(receipt);
  expect(
    push(upgraded, alpha, put("second", "collision", null, mealContent("saved-item"))).results,
  ).toMatchObject([{ status: "rejected", code: "invalid-content" }]);
  expect(
    push(upgraded, alpha, put("second", "available", null, mealContent("released-item"))).results,
  ).toMatchObject([{ status: "accepted", revision: 4 }]);
});

test("leaves a v1 file intact when an existing item ID has two live owners", () => {
  {
    using store = openSyncStore(filename);
    const session = sessionFor(store.createAccount("alpha", "history-alpha"));
    push(store, session, put("first", "initial-a", null, mealContent("shared")));
    push(store, session, put("second", "initial-b", null, mealContent("different")));
  }
  {
    using old = new DatabaseSync(filename);
    candidateV1(old);
    old
      .prepare("UPDATE sync_records SET content = ? WHERE record_id = 'second'")
      .run(JSON.stringify(mealContent("shared")));
  }
  const before = readFileSync(filename);
  expect(() => openSyncStore(filename)).toThrow(
    "A stored meal item ID already belongs to another meal",
  );
  expect(readFileSync(filename)).toEqual(before);
  using inspected = new DatabaseSync(filename, { readOnly: true });
  expect(inspected.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  expect(
    inspected.prepare("SELECT name FROM sqlite_schema WHERE name = 'sync_meal_item_owners'").get(),
  ).toBeUndefined();
  expect(
    inspected.prepare("SELECT revision FROM sync_accounts WHERE account_binding = 'alpha'").get()
      ?.revision,
  ).toBe(2);
});

test("the upgraded index also constrains a statement prepared before the migration", () => {
  {
    using store = openSyncStore(filename);
    const alpha = sessionFor(store.createAccount("alpha", "history-alpha"));
    push(store, alpha, put("first", "first-put", null, mealContent("claimed")));
  }
  using old = new DatabaseSync(filename);
  candidateV1(old);
  const oldWrite = old.prepare(`
    INSERT INTO sync_records (account_binding, revision, kind, record_id, content)
    VALUES ('alpha', 2, 'meal', 'second', ?)
    ON CONFLICT (account_binding, kind, record_id) DO UPDATE SET
      revision = excluded.revision, content = excluded.content
  `);
  using upgraded = openSyncStore(filename);
  old.exec("BEGIN IMMEDIATE");
  try {
    expect(() => oldWrite.run(JSON.stringify(mealContent("claimed")))).toThrow(/unique/i);
    oldWrite.run(JSON.stringify(mealContent("available")));
    expect(
      old.prepare("SELECT meal_id FROM sync_meal_item_owners WHERE item_id = 'available'").get()
        ?.meal_id,
    ).toBe("second");
  } finally {
    old.exec("ROLLBACK");
  }
  const alpha = sessionFor(upgraded.history("alpha"));
  expect(pull(upgraded, alpha).changes).toMatchObject([{ id: "first" }]);
});

test.skipIf(process.platform === "win32")(
  "rejects existing files with group or other permissions without changing them",
  () => {
    {
      using store = openSyncStore(filename);
      store.createAccount("alpha", "history-alpha");
    }
    const before = readFileSync(filename);
    for (const permissions of [0o640, 0o602]) {
      chmodSync(filename, permissions);
      expect(() => openSyncStore(filename)).toThrow(
        "A sync database must have private file permissions",
      );
      expect(statSync(filename).mode & 0o777).toBe(permissions);
      expect(readFileSync(filename)).toEqual(before);
    }
  },
);

test("fences old sessions on a restored database and a lineage change", () => {
  const backup = join(directory, "before-restore.sqlite");
  {
    using store = openSyncStore(filename);
    const session = sessionFor(store.createAccount("alpha", "history-alpha"));
    push(store, session, put("meal", "first", null, { name: "Initial" }));
  }
  copyFileSync(filename, backup);
  let newer: NegotiatedSync | undefined;
  {
    using store = openSyncStore(filename);
    const session = sessionFor(store.history("alpha"));
    push(store, session, put("meal", "second", 1, { name: "Newer" }));
    newer = sessionFor(store.history("alpha"));
  }
  copyFileSync(backup, filename);
  using store = openSyncStore(filename);
  const restored = sessionFor(store.history("alpha"));
  expectWireError(() => pull(store, restored, 2), "cursor-reset");
  expectWireError(() => pull(store, newer, 0), "cursor-reset");
  expectWireError(() => push(store, newer, put("meal", "stale-device", 1, {})), "cursor-reset");
  using recovery = new DatabaseSync(filename);
  recovery.exec(
    "UPDATE sync_accounts SET lineage = 'history-recovered', restored_lineage = 'history-alpha', restored_revision = 1",
  );
  expectWireError(() => pull(store, restored), "lineage-changed");
  expectWireError(
    () => push(store, restored, put("meal", "old-lineage", 1, {})),
    "lineage-changed",
  );
  const current = sessionFor(store.history("alpha"));
  expect(current).toMatchObject({
    lineage: "history-recovered",
    restoredFrom: { lineage: "history-alpha", revision: 1 },
  });
  expect(pull(store, current).changes).toMatchObject([
    { content: { name: "Initial" }, revision: 1 },
  ]);
});

test("rolls back the entire batch if a receipt insert fails after writing its change", () => {
  using store = openSyncStore(filename);
  using db = new DatabaseSync(filename);
  const session = sessionFor(store.createAccount("alpha", "history-alpha"));
  db.exec(`
    CREATE TRIGGER synthetic_write_failure BEFORE INSERT ON sync_receipts
    WHEN NEW.submission_id = 'second' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;
  `);
  const uploads = [
    put("lunch", "first", null, mealContent("lunch-item")),
    put("dinner", "second", null, mealContent("dinner-item")),
  ];
  expect(() => push(store, session, ...uploads)).toThrow("synthetic failure");
  expect(store.history("alpha")?.revision).toBe(0);
  expect(pull(store, session).changes).toEqual([]);
  expect(db.prepare("SELECT COUNT(*) AS count FROM sync_receipts").get()?.count).toBe(0);
  expect(db.prepare("SELECT COUNT(*) AS count FROM sync_meal_item_owners").get()?.count).toBe(0);
  db.exec("DROP TRIGGER synthetic_write_failure");
  expect(push(store, session, ...uploads).results).toMatchObject([
    { status: "accepted", revision: 1 },
    { status: "accepted", revision: 2 },
  ]);
  expect(db.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("retains the account state while a second SQLite writer holds a lock", () => {
  using store = openSyncStore(filename);
  using competing = new DatabaseSync(filename);
  const session = sessionFor(store.createAccount("alpha", "history-alpha"));
  const submission = put("meal", "after-lock", null, { name: "Fruit" });
  competing.exec("BEGIN IMMEDIATE");
  try {
    expect(() => push(store, session, submission)).toThrow(/locked/i);
    expect(store.history("alpha")?.revision).toBe(0);
    expect(pull(store, session).changes).toEqual([]);
  } finally {
    competing.exec("ROLLBACK");
  }
  expect(push(store, session, submission).results).toEqual([
    { status: "accepted", submissionId: "after-lock", revision: 1 },
  ]);
});

test("receipts distinguish domain validation from unexpected projection errors", () => {
  using store = openSyncStore(filename, {
    applyContent({ key, release, current, submitted }) {
      expect(release).toBe("0.1");
      if (key.id === "invalid") throw new InvalidSyncContent("Missing synthetic field");
      if (key.id === "interrupted") throw new Error("Projection interrupted");
      return { ...current, ...submitted };
    },
  });
  const session = sessionFor(store.createAccount("alpha", "history-alpha"));
  expect(
    push(
      store,
      session,
      put("normal", "first", null, { name: "Toast", future: true }),
      put("invalid", "invalid", null, {}),
    ).results,
  ).toMatchObject([
    { status: "accepted", revision: 1 },
    { status: "rejected", code: "invalid-content", message: "Missing synthetic field" },
  ]);
  expect(push(store, session, put("normal", "update", 1, { name: "Bagel" })).results).toMatchObject(
    [{ status: "accepted", revision: 2 }],
  );
  expect(() =>
    push(
      store,
      session,
      put("normal", "discard", 2, { name: "Discarded" }),
      put("interrupted", "interrupted", null, {}),
    ),
  ).toThrow("Projection interrupted");
  expect(pull(store, session, 1)).toMatchObject({
    changes: [{ revision: 2, content: { name: "Bagel", future: true } }],
  });
});

test("bounds serialized pull and push responses while retaining full conflict receipts", () => {
  using store = openSyncStore(filename);
  const session = sessionFor(store.createAccount("alpha", "history-alpha"));
  const content = { note: "x".repeat(384 * 1024) };
  const ids = ["x", "y", "z"];
  for (const id of ids) push(store, session, put(id, `first-${id}`, null, content));
  push(store, session, remove("gone", "delete-gone", null));
  const requests = [
    ...ids.map((id) => put(id, `conflict-${id}`, null, {})),
    put("gone", "conflict-gone", null, {}),
  ];
  const response = push(store, session, ...requests);
  expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(maxSyncEnvelopeBytes);
  expect(response.results).toMatchObject([
    {
      status: "conflict",
      submissionId: "conflict-x",
      reason: "exists",
      current: { state: "unavailable", kind: "meal", id: "x", revision: 1 },
    },
    { status: "conflict", submissionId: "conflict-y", current: { state: "live", id: "y" } },
    { status: "conflict", submissionId: "conflict-z", current: { state: "live", id: "z" } },
    {
      status: "conflict",
      submissionId: "conflict-gone",
      reason: "deleted",
      current: { state: "deleted", id: "gone" },
    },
  ]);
  expect(push(store, session, ...requests)).toEqual(response);
  expect(push(store, session, put("x", "conflict-x", null, {})).results).toMatchObject([
    { current: { state: "live", content } },
  ]);
  const firstPage = pull(store, session, 0, 500);
  expect(firstPage).toMatchObject({ cursor: 2, hasMore: true });
  const secondPage = pull(store, session, firstPage.cursor, 500);
  expect(secondPage).toMatchObject({ cursor: 4, hasMore: false });
  for (const page of [firstPage, secondPage]) {
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(maxSyncEnvelopeBytes);
  }
});

test("rejects projected records too large to fit a pull page and leaves existing SQLite files alone", () => {
  {
    using store = openSyncStore(filename, {
      applyContent: () => ({ name: "x".repeat(maxSyncEnvelopeBytes) }),
    });
    const session = sessionFor(store.createAccount("alpha", "history-alpha"));
    expect(push(store, session, put("meal", "large", null, {})).results).toMatchObject([
      { status: "rejected", code: "invalid-content" },
    ]);
    expect(pull(store, session)).toMatchObject({ cursor: 0, changes: [] });
  }
  const unrelated = join(directory, "private-diary.sqlite");
  using existing = new DatabaseSync(unrelated);
  if (process.platform !== "win32") chmodSync(unrelated, 0o600);
  existing.exec("CREATE TABLE private_records (id TEXT PRIMARY KEY)");
  expect(() => openSyncStore(unrelated)).toThrow("Unsupported sync database");
  expect(existing.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([
    { name: "private_records" },
  ]);
});

test("gives a stale writer the current record even if the old payload fails projection", () => {
  using store = openSyncStore(filename, {
    applyContent({ submitted }) {
      if (submitted.oldUnsupportedField === true) throw new InvalidSyncContent("Unsupported field");
      return submitted;
    },
  });
  const session = sessionFor(store.createAccount("alpha", "history-alpha"));
  push(store, session, put("meal", "first", null, { name: "First" }));
  push(store, session, put("meal", "newer", 1, { name: "Current" }));
  const edit = { name: "Offline edit", oldUnsupportedField: true };
  expect(push(store, session, put("meal", "stale-draft", 1, edit)).results).toMatchObject([
    { status: "conflict", reason: "stale", current: { revision: 2, content: { name: "Current" } } },
  ]);
  expect(push(store, session, put("meal", "invalid-draft", 2, edit)).results).toMatchObject([
    { status: "rejected", code: "invalid-content" },
  ]);
});
