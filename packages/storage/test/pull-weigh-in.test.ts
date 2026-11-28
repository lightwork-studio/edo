import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Change, decodeChange, type SubmissionResult } from "@edo/contract";
import { type DiarySqliteConnection, openDiary } from "@edo/storage";
import { createSyncClient } from "@edo/sync";
import { afterEach, expect, test } from "vitest";

const connections: DatabaseSync[] = [];
const directories: string[] = [];
const day = "2026-11-10";
const original = { id: "reading-first", localDay: day, occurredAt: 1794297600000, kg: 80 };
const second = { ...original, id: "reading-second", kg: 84 };
const local = { ...original, kg: 81 };
const server = { ...original, kg: 82, futureUnit: "fixture" };
const key = { kind: "weigh-in", id: original.id };

afterEach(() => {
  for (const db of connections.splice(0)) if (db.isOpen) db.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function phone(path?: string) {
  if (!path) {
    const directory = mkdtempSync(join(tmpdir(), "edo-weigh-in-pull-"));
    directories.push(directory);
    path = join(directory, "device.sqlite");
  }
  const db = new DatabaseSync(path);
  connections.push(db);
  const connection: DiarySqliteConnection = {
    exec: (sql) => db.exec(sql),
    run: (sql, ...parameters) => void db.prepare(sql).run(...parameters),
    all: (sql, ...parameters) => db.prepare(sql).all(...parameters),
    get: (sql, ...parameters) => db.prepare(sql).get(...parameters),
  };
  const diary = await openDiary({
    connection,
    async backupBeforeMigration() {
      throw new Error("The test diary is blank or current");
    },
  });
  return { db, diary, path };
}

function live(content: typeof original, revision: number): Change {
  return decodeChange({ kind: "weigh-in", id: content.id, state: "live", revision, content });
}

function fakeAccount(revision: number, accountBinding = "fixture") {
  const scope = { release: "0.1", accountBinding, lineage: "fixture-lineage" };
  let page = { cursor: 0, hasMore: false, changes: [] as Change[] };
  let results: SubmissionResult[] = [];
  const client = createSyncClient({
    origin: "https://example.test",
    authorization: () => "Bearer synthetic",
    releases: [{ release: "0.1", writableKinds: ["weigh-in"], features: ["write-records"] }],
    fetch: async (request) => {
      const path = new URL(String(request)).pathname;
      if (path === "/sync/pull") return Response.json({ ...scope, ...page });
      if (path === "/sync/push") return Response.json({ ...scope, results });
      if (path !== "/sync/hello") throw new Error("Unexpected sync request");
      return Response.json({ ...scope, revision, restoredFrom: null, features: ["write-records"] });
    },
  });
  return {
    client,
    page(cursor: number, changes: Change[]) {
      page = { cursor, hasMore: false, changes };
    },
    receipts(next: SubmissionResult[]) {
      results = next;
    },
  };
}

test("applies a page atomically and uses its verified local snapshots after reopening", async () => {
  const source = await phone();
  const { db, diary } = source;
  const account = fakeAccount(2);
  const session = await account.client.connect();
  diary.sync.journal.bind(session);
  account.page(2, [live(original, 1), live(second, 2)]);
  const page = await account.client.pull(session, 0);
  db.exec(`CREATE TRIGGER interrupt_second_weight BEFORE INSERT ON diary_weigh_ins
    WHEN new.id = 'reading-second' BEGIN SELECT RAISE(ABORT, 'unavailable'); END`);
  expect(() => diary.sync.applyWeighInPull(session, 0, page)).toThrow(/unavailable/);
  expect(diary.listWeighIns(day, day)).toEqual([]);
  expect(diary.sync.journal.history()).toMatchObject({ cursor: 0 });
  expect(diary.sync.journal.serverCopy(key)).toBeNull();
  expect(db.prepare("SELECT * FROM edo_sync_applied_weigh_ins").all()).toEqual([]);
  db.exec("DROP TRIGGER interrupt_second_weight");
  db.exec(`CREATE TRIGGER ignore_second_proof BEFORE INSERT ON edo_sync_applied_weigh_ins
    WHEN new.id = 'reading-second' BEGIN SELECT RAISE(IGNORE); END`);
  expect(() => diary.sync.applyWeighInPull(session, 0, page)).toThrow(/evidence changed/);
  expect(diary.listWeighIns(day, day)).toEqual([]);
  expect(diary.sync.journal.history()).toMatchObject({ cursor: 0 });
  expect(db.prepare("SELECT * FROM edo_sync_applied_weigh_ins").all()).toEqual([]);
  db.exec("DROP TRIGGER ignore_second_proof");

  diary.sync.applyWeighInPull(session, 0, page);
  expect(diary.listWeighIns(day, day)).toEqual([original, second]);
  db.close();

  const resumed = (await phone(source.path)).diary;
  const { journal } = resumed.sync;
  const history = journal.history();
  if (!history) throw new Error("Expected a bound device after reopening");
  const nextSession = await account.client.connect(history);
  journal.bind(nextSession);
  account.page(3, [live(server, 3)]);
  resumed.sync.applyWeighInPull(nextSession, 2, await account.client.pull(nextSession, 2));
  expect(resumed.listWeighIns(day, day)).toEqual([{ ...original, kg: 82 }, second]);
  expect(journal.serverCopy(key)).toEqual(live(server, 3));
  const deleted = decodeChange({ ...key, state: "deleted", revision: 4 });
  account.page(4, [deleted]);
  resumed.sync.applyWeighInPull(nextSession, 3, await account.client.pull(nextSession, 3));
  expect(resumed.listWeighIns(day, day)).toEqual([second]);
  account.page(5, [live(server, 5)]);
  const revived = await account.client.pull(nextSession, 4);
  expect(() => resumed.sync.applyWeighInPull(nextSession, 4, revived)).toThrow(/deleted weigh-in/);
  expect(resumed.listWeighIns(day, day)).toEqual([second]);
  expect(journal.serverCopy(key)).toEqual(deleted);
  expect(journal.history()).toMatchObject({ cursor: 4 });
});

test("preserves an equal same-ID offline row without adopting the account revision", async () => {
  const { db, diary } = await phone();
  const account = fakeAccount(1);
  const { journal } = diary.sync;
  diary.saveWeighIn(original);
  const session = await account.client.connect();
  journal.bind(session);
  db.exec("CREATE TEMP TABLE diary_weigh_ins AS SELECT * FROM main.diary_weigh_ins WHERE 0");
  account.page(1, [live(original, 1)]);
  const page = await account.client.pull(session, 0);
  expect(() => diary.sync.applyWeighInPull(session, 0, page)).toThrow(
    /saved weigh-in needs review/,
  );
  expect(diary.listWeighIns(day, day)).toEqual([original]);
  expect(journal.serverCopy(key)).toBeNull();
  expect(journal.history()).toMatchObject({ cursor: 0 });
  diary.sync.saveWeighIn(local, "reviewed-local-edit");
  expect(journal.prepare(session)).toMatchObject([
    { ...key, submissionId: "reviewed-local-edit", baseRevision: null, content: local },
  ]);
  expect(db.prepare("SELECT * FROM temp.diary_weigh_ins").all()).toEqual([]);
});

test("rejects a different account and ignores temporary journal copies while applying the bound account", async () => {
  const { db, diary } = await phone();
  const account = fakeAccount(1);
  const session = await account.client.connect();
  const { journal } = diary.sync;
  journal.bind(session);
  db.exec(`
    CREATE TEMP TABLE edo_sync_binding AS SELECT * FROM main.edo_sync_binding WHERE 0;
    CREATE TEMP TABLE edo_sync_remote AS SELECT * FROM main.edo_sync_remote WHERE 0;
    CREATE TEMP TABLE edo_sync_outbox AS SELECT * FROM main.edo_sync_outbox WHERE 0;
  `);
  const different = fakeAccount(1, "different");
  const differentSession = await different.client.connect();
  expect(() => journal.bind(differentSession)).toThrow(
    expect.objectContaining({ code: "account-changed" }),
  );
  account.page(1, [live(original, 1)]);
  diary.sync.applyWeighInPull(session, 0, await account.client.pull(session, 0));
  expect(journal.history()).toMatchObject({ accountBinding: "fixture", cursor: 1 });
  expect(journal.serverCopy(key)).toEqual(live(original, 1));
  expect(diary.listWeighIns(day, day)).toEqual([original]);
  expect(db.prepare("SELECT * FROM temp.edo_sync_binding").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM temp.edo_sync_remote").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM temp.edo_sync_outbox").all()).toEqual([]);
});

test.each([
  ["INSERT", "edo_sync_remote", "account copy"],
  ["INSERT", "edo_sync_outbox", "sync outbox"],
  ["UPDATE", "edo_sync_binding", "sync binding"],
])(
  "rolls back a guarded page when SQLite silently skips %s on %s",
  async (operation, table, failure) => {
    const { db, diary } = await phone();
    const account = fakeAccount(1);
    const session = await account.client.connect();
    const { journal } = diary.sync;
    journal.bind(session);
    account.page(1, [live(original, 1)]);
    const page = await account.client.pull(session, 0);
    db.exec(`CREATE TRIGGER ignore_write BEFORE ${operation} ON ${table}
    BEGIN SELECT RAISE(IGNORE); END`);
    expect(() => diary.sync.applyWeighInPull(session, 0, page)).toThrow(failure);
    expect(journal.history()).toMatchObject({ cursor: 0 });
    expect(journal.serverCopy(key)).toBeNull();
    expect(diary.listWeighIns(day, day)).toEqual([]);
    expect(db.prepare("SELECT * FROM main.edo_sync_applied_weigh_ins").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM main.edo_sync_outbox").all()).toEqual([]);
    db.exec("DROP TRIGGER ignore_write");
    diary.sync.applyWeighInPull(session, 0, page);
    expect(journal.history()).toMatchObject({ cursor: 1 });
    expect(journal.serverCopy(key)).toEqual(live(original, 1));
    expect(diary.listWeighIns(day, day)).toEqual([original]);
  },
);

test.each([
  ["edo_sync_receipts", "sync receipt"],
  ["edo_sync_weigh_in_projections", "accepted weigh-in evidence"],
])("keeps a receipt retryable when SQLite silently skips %s", async (table, failure) => {
  const { db, diary } = await phone();
  const account = fakeAccount(0);
  const session = await account.client.connect();
  const { journal } = diary.sync;
  journal.bind(session);
  diary.sync.saveWeighIn(original, "first-receipt");
  const attempt = journal.prepare(session);
  account.receipts([{ submissionId: "first-receipt", status: "accepted", revision: 1 }]);
  const receipt = await account.client.push(session, attempt);
  db.exec(`CREATE TRIGGER ignore_write BEFORE INSERT ON ${table}
    BEGIN SELECT RAISE(IGNORE); END`);
  expect(() => diary.sync.applyWeighInReceipts(session, receipt)).toThrow(failure);
  expect(journal.history()).toMatchObject({ cursor: 0, revision: 0 });
  expect(journal.prepare(session)).toEqual(attempt);
  expect(journal.acceptedWeighIn(key.id)).toBeNull();
  expect(db.prepare("SELECT * FROM main.edo_sync_receipts").all()).toEqual([]);
  db.exec("DROP TRIGGER ignore_write");
  diary.sync.applyWeighInReceipts(session, receipt);
  diary.sync.applyWeighInReceipts(session, receipt);
  expect(journal.queued()).toEqual([]);
  expect(journal.acceptedWeighIn(key.id)).toEqual({ revision: 1, content: original });
});

test("requires device evidence for an older observed copy before moving the saved weigh-in", async () => {
  const { db, diary } = await phone();
  const account = fakeAccount(1);
  const session = await account.client.connect();
  const { journal } = diary.sync;
  journal.bind(session);
  diary.saveWeighIn(original);
  account.page(1, [live(original, 1)]);
  journal.applyPage(session, 0, await account.client.pull(session, 0), () => undefined);
  db.exec("CREATE TEMP TABLE edo_sync_applied_weigh_ins (id TEXT, revision INTEGER, content TEXT)");
  db.prepare("INSERT INTO temp.edo_sync_applied_weigh_ins VALUES (?, 1, ?)").run(
    original.id,
    JSON.stringify(original),
  );
  account.page(2, [live(server, 2)]);
  const page = await account.client.pull(session, 1);
  expect(() => diary.sync.applyWeighInPull(session, 1, page)).toThrow(/previous device weigh-in/);
  expect(diary.listWeighIns(day, day)).toEqual([original]);
  expect(journal.serverCopy(key)).toEqual(live(original, 1));
  expect(journal.history()).toMatchObject({ cursor: 1 });
});

test.each(["receipt first", "pull first", "pull first with newer device edit"] as const)(
  "checks device evidence when applying a stale acknowledgment with %s",
  async (ordering) => {
    const { db, diary } = await phone();
    const { journal } = diary.sync;
    const account = fakeAccount(1);
    const session = await account.client.connect();
    journal.bind(session);
    account.page(1, [live(original, 1)]);
    diary.sync.applyWeighInPull(session, 0, await account.client.pull(session, 0));
    diary.sync.saveWeighIn(local, "in-flight");
    const attempt = journal.prepare(session);
    account.receipts([{ submissionId: "in-flight", status: "accepted", revision: 2 }]);
    const receipt = await account.client.push(session, attempt);
    account.page(3, [live(server, 3)]);
    const next = await account.client.pull(session, 1);

    if (ordering === "receipt first") {
      diary.sync.applyWeighInReceipts(session, receipt);
      expect(journal.acceptedWeighIn(key.id)).toEqual({ revision: 2, content: local });
      diary.sync.applyWeighInPull(session, 1, next);
    } else {
      diary.sync.applyWeighInPull(session, 1, next);
      if (ordering === "pull first with newer device edit") {
        const newer = { ...local, kg: 83 };
        diary.saveWeighIn(newer);
        expect(() => diary.sync.applyWeighInReceipts(session, receipt)).toThrow(
          /saved weigh-in needs review/,
        );
        expect(diary.listWeighIns(day, day)).toEqual([newer]);
        expect(journal.prepare(session)).toEqual(attempt);
        expect(journal.serverCopy(key)).toEqual(live(server, 3));
        diary.saveWeighIn(local);
      }
      diary.sync.applyWeighInReceipts(session, receipt);
    }

    diary.sync.applyWeighInReceipts(session, receipt);
    expect(diary.listWeighIns(day, day)).toEqual([{ ...original, kg: 82 }]);
    expect(journal.serverCopy(key)).toEqual(live(server, 3));
    expect(journal.queued()).toEqual([]);
    expect(journal.acceptedWeighIn(key.id)).toBeNull();
    expect(
      db.prepare("SELECT revision FROM edo_sync_applied_weigh_ins WHERE id = ?").get(key.id),
    ).toEqual({
      revision: 3,
    });
  },
);

test("finalizes an accepted no-op receipt without touching a newer independent device edit", async () => {
  const { db, diary } = await phone();
  const account = fakeAccount(1);
  const session = await account.client.connect();
  const { journal } = diary.sync;
  journal.bind(session);
  account.page(1, [live(original, 1)]);
  diary.sync.applyWeighInPull(session, 0, await account.client.pull(session, 0));
  diary.sync.saveWeighIn(original, "accepted-no-op");
  const attempt = journal.prepare(session);
  account.receipts([{ submissionId: "accepted-no-op", status: "accepted", revision: 1 }]);
  const receipt = await account.client.push(session, attempt);
  diary.saveWeighIn(local);

  diary.sync.applyWeighInReceipts(session, receipt);
  diary.sync.applyWeighInReceipts(session, receipt);
  expect(journal.requiredRelease()).toBeNull();
  expect(journal.queued()).toEqual([]);
  expect(journal.serverCopy(key)).toEqual(live(original, 1));
  expect(diary.listWeighIns(day, day)).toEqual([local]);
  expect(db.prepare("SELECT revision, content FROM main.edo_sync_applied_weigh_ins").all()).toEqual(
    [{ revision: 1, content: JSON.stringify(original) }],
  );
});

test("preserves an observed tombstone during an in-flight edit and rejects an unavailable page", async () => {
  const { diary } = await phone();
  const account = fakeAccount(1);
  const session = await account.client.connect();
  const { journal } = diary.sync;
  journal.bind(session);
  account.page(1, [live(original, 1)]);
  diary.sync.applyWeighInPull(session, 0, await account.client.pull(session, 0));
  diary.sync.saveWeighIn(local, "in-flight-before-tombstone");
  const attempt = journal.prepare(session);
  account.receipts([
    { submissionId: "in-flight-before-tombstone", status: "accepted", revision: 2 },
  ]);
  const receipt = await account.client.push(session, attempt);
  const tombstone = decodeChange({ ...key, state: "deleted", revision: 3 });
  account.page(3, [tombstone]);
  diary.sync.applyWeighInPull(session, 1, await account.client.pull(session, 1));
  account.page(4, [live(server, 4)]);
  const resurrection = await account.client.pull(session, 3);
  expect(() => diary.sync.applyWeighInPull(session, 3, resurrection)).toThrow(/deleted weigh-in/);
  expect(journal.serverCopy(key)).toEqual(tombstone);
  expect(journal.history()).toMatchObject({ cursor: 3 });
  expect(journal.prepare(session)).toEqual(attempt);

  const unavailable = decodeChange({ ...key, id: second.id, state: "unavailable", revision: 5 });
  account.page(5, [live({ ...second, id: "third" }, 4), unavailable]);
  const page = await account.client.pull(session, 3);
  expect(() => diary.sync.applyWeighInPull(session, 3, page)).toThrow(/weigh-in is unavailable/);
  expect(journal.history()).toMatchObject({ cursor: 3 });
  expect(journal.serverCopy({ ...key, id: "third" })).toBeNull();
  expect(diary.listWeighIns(day, day)).toEqual([local]);

  diary.sync.applyWeighInReceipts(session, receipt);
  expect(journal.serverCopy(key)).toEqual(tombstone);
  expect(diary.listWeighIns(day, day)).toEqual([]);
});

test("records opaque changes at a new owned revision without rewriting the saved weight", async () => {
  const { db, diary } = await phone();
  const account = fakeAccount(1);
  const session = await account.client.connect();
  const { journal } = diary.sync;
  journal.bind(session);
  account.page(1, [live(original, 1)]);
  diary.sync.applyWeighInPull(session, 0, await account.client.pull(session, 0));
  db.exec(`CREATE TRIGGER no_duplicate_weight_write BEFORE INSERT ON diary_weigh_ins
    BEGIN SELECT RAISE(ABORT, 'unnecessary weight write'); END`);
  const modified = { ...original, futureUnit: "optional private data" };
  account.page(2, [live(modified, 2)]);
  diary.sync.applyWeighInPull(session, 1, await account.client.pull(session, 1));
  expect(journal.serverCopy(key)).toEqual(live(modified, 2));
  expect(diary.listWeighIns(day, day)).toEqual([original]);
  expect(db.prepare("SELECT revision, content FROM main.edo_sync_applied_weigh_ins").all()).toEqual(
    [{ revision: 2, content: JSON.stringify(original) }],
  );
});
