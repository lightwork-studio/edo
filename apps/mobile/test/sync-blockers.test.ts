import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDiary, type SqliteConnection } from "@edo/storage";
import { expect, it } from "vitest";
import { readSyncBlocker, syncBlockerNotice } from "../src/sync-blockers";

function connectionFor(db: DatabaseSync): SqliteConnection {
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...parameters) => void db.prepare(sql).run(...parameters),
    get: (sql, ...parameters) => db.prepare(sql).get(...parameters),
    all: (sql, ...parameters) => db.prepare(sql).all(...parameters),
  };
}

function open(db: DatabaseSync) {
  return openDiary({
    connection: connectionFor(db),
    async backupBeforeMigration() {
      throw new Error("The test diary is blank or current");
    },
  });
}

it("finds persisted record blockers offline and exposes only their presentation fields", async () => {
  const temp = mkdtempSync(join(tmpdir(), "edo-mobile-sync-blockers-"));
  const path = join(temp, "diary.sqlite");
  const meal = { kind: "meal", id: "fixture-meal" };
  const weight = { kind: "weigh-in", id: "fixture-weight" };
  const privateText = { name: "Private test content" };
  try {
    {
      using db = new DatabaseSync(path);
      const diary = await open(db);
      expect(syncBlockerNotice(diary.sync.journal)).toBe("clear");
      db.exec(`INSERT INTO edo_sync_binding
        VALUES (1, 'https://example.test', 'account', 'lineage', 2, 1)`);
      const insert = db.prepare("INSERT INTO edo_sync_outbox VALUES (?, ?, NULL, NULL, ?)");
      for (const key of [meal, weight]) {
        const submissionId = `old-${key.id}`;
        const isMeal = key === meal;
        const record = {
          key,
          baseRevision: null,
          base: null,
          pending: isMeal ? { op: "delete", submissionId: "new-meal-edit" } : null,
          attempt: null,
          blocked: {
            submission: {
              ...key,
              baseRevision: null,
              submissionId,
              op: "put",
              content: privateText,
            },
            result: isMeal
              ? {
                  submissionId,
                  status: "conflict",
                  reason: "exists",
                  current: { ...key, state: "live", revision: 1, content: privateText },
                }
              : {
                  submissionId,
                  status: "rejected",
                  code: "invalid-content",
                  message: "Account response detail",
                },
          },
        };
        insert.run(key.kind, key.id, JSON.stringify(record));
      }
    }

    using reopened = new DatabaseSync(path);
    const diary = await open(reopened);
    const { journal } = diary.sync;
    const rawBefore = reopened
      .prepare("SELECT content FROM edo_sync_outbox ORDER BY kind, id")
      .all();
    expect(syncBlockerNotice(journal)).toBe("blocked");
    const first = readSyncBlocker(journal, null);
    expect(first).toEqual({
      state: "blocked",
      kind: "meal",
      reason: "exists",
      operation: "delete",
      next: meal,
    });
    if (first.state !== "blocked") throw new Error("Expected the first blocker");
    expect(readSyncBlocker(journal, first.next)).toEqual({
      state: "blocked",
      kind: "weigh-in",
      reason: "invalid-content",
      operation: "put",
      next: null,
      weighIn: { phone: { state: "unavailable" }, account: { state: "unknown" } },
    });
    expect(reopened.prepare("SELECT content FROM edo_sync_outbox ORDER BY kind, id").all()).toEqual(
      rawBefore,
    );
    expect(readSyncBlocker({ ...journal, blockedReview: () => null }, null)).toEqual({
      state: "changed",
      next: meal,
    });
    reopened.exec(`UPDATE edo_sync_outbox SET
      content = json_set(content, '$.blocked.submission.op', 'invalid') WHERE kind = 'meal'`);
    const unreadable = readSyncBlocker(journal, null);
    expect(unreadable).toEqual({ state: "error", next: meal });
    expect(readSyncBlocker(journal, unreadable.next)).toMatchObject({
      state: "blocked",
      kind: "weigh-in",
    });
    reopened.exec(`UPDATE edo_sync_outbox SET content =
      json_set(content, '$.blocked.submission.op', 'put', '$.blocked.result.status', 'damaged')
      WHERE kind = 'meal'`);
    expect(() => journal.blockedRecords(null, 1)).toThrow(/Invalid blocked sync record/);
    expect(syncBlockerNotice(journal)).toBe("blocked");
    const malformedStatus = readSyncBlocker(journal, null);
    expect(malformedStatus).toEqual({ state: "error", next: meal });
    expect(readSyncBlocker(journal, malformedStatus.next)).toMatchObject({
      state: "blocked",
      kind: "weigh-in",
    });

    // An invalid receipt can also defeat an adapter's integer conversion before validation.
    reopened.exec(`UPDATE edo_sync_outbox SET content =
      json_set(content, '$.blocked.result.status', 9007199254740992) WHERE kind = 'meal'`);
    expect(readSyncBlocker(journal, null)).toEqual({ state: "error", next: meal });
    expect(readSyncBlocker(journal, meal)).toMatchObject({ state: "blocked", kind: "weigh-in" });

    // The marker itself can be damaged while the row still passes the JSON constraint.
    reopened.exec(`UPDATE edo_sync_outbox SET content =
      json_set(content, '$.blocked', 'damaged') WHERE kind = 'meal'`);
    expect(journal.blockedRecords(null, 1).records.map(({ key }) => key)).toEqual([weight]);
    expect(syncBlockerNotice(journal)).toBe("blocked");
    expect(readSyncBlocker(journal, null)).toEqual({ state: "error", next: meal });
    expect(readSyncBlocker(journal, meal)).toMatchObject({ state: "blocked", kind: "weigh-in" });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("shows the latest phone change and account weigh-in without opaque or identity fields", async () => {
  using db = new DatabaseSync(":memory:");
  const {
    sync: { journal },
  } = await open(db);
  const key = { kind: "weigh-in", id: "reviewed-weight" };
  const captured = {
    id: key.id,
    kg: 80.002,
    localDay: "2026-11-10",
    occurredAt: Date.parse("2026-11-11T00:30:00.003Z"),
  };
  const { id: _id, ...visible } = captured;
  const submitted = { ...captured, kg: 79 };
  const received = { ...key, state: "live", revision: 2, content: { ...captured, kg: 81 } };
  const pulled = {
    ...received,
    revision: 3,
    content: { ...captured, kg: 81.003, future: "opaque fixture field" },
  };
  db.exec(`INSERT INTO edo_sync_binding
    VALUES (1, 'https://example.test', 'account', 'lineage', 3, 3)`);
  db.prepare("INSERT INTO edo_sync_outbox VALUES (?, ?, NULL, NULL, ?)").run(
    key.kind,
    key.id,
    JSON.stringify({
      key,
      baseRevision: 1,
      base: null,
      pending: { op: "put", submissionId: "latest", content: { ...captured, private: "fixture" } },
      attempt: null,
      blocked: {
        submission: {
          ...key,
          baseRevision: 1,
          submissionId: "prior",
          op: "put",
          content: submitted,
        },
        result: { submissionId: "prior", status: "conflict", reason: "stale", current: received },
      },
    }),
  );
  db.prepare("INSERT INTO edo_sync_remote VALUES (?, ?, ?, ?)").run(
    key.kind,
    key.id,
    pulled.revision,
    JSON.stringify(pulled),
  );
  const review = readSyncBlocker(journal, null);
  if (review.state !== "blocked") throw new Error("Expected a tracked weigh-in conflict");
  expect(review.weighIn).toEqual({
    phone: { state: "live", ...visible },
    account: { state: "live", ...visible, kg: 81.003 },
  });

  const setAccount = db.prepare("UPDATE edo_sync_remote SET revision = ?, content = ?");
  setAccount.run(2, JSON.stringify({ ...received, content: { ...captured, kg: 83 } }));
  expect(readSyncBlocker(journal, null)).toMatchObject({
    weighIn: { account: { state: "unavailable" } },
  });
  const setReceipt = db.prepare(
    "UPDATE edo_sync_outbox SET content = json_set(content, '$.blocked.result.current', json(?))",
  );
  setReceipt.run(JSON.stringify({ ...key, revision: 2, state: "unavailable" }));
  expect(readSyncBlocker(journal, null)).toMatchObject({
    weighIn: { account: { state: "live", ...visible, kg: 83 } },
  });
  setAccount.run(2, JSON.stringify({ ...key, revision: 2, state: "deleted" }));
  expect(readSyncBlocker(journal, null)).toMatchObject({
    weighIn: { account: { state: "unavailable" } },
  });
  setReceipt.run(JSON.stringify({ ...received, content: { ...captured, kg: 82 } }));
  setAccount.run(2, JSON.stringify({ ...key, revision: 2, state: "unavailable" }));
  expect(readSyncBlocker(journal, null)).toMatchObject({
    weighIn: { account: { state: "live", ...visible, kg: 82 } },
  });
  setReceipt.run(JSON.stringify({ ...key, revision: 2, state: "deleted" }));
  setAccount.run(3, JSON.stringify({ ...received, revision: 3 }));
  expect(readSyncBlocker(journal, null)).toMatchObject({
    weighIn: { account: { state: "unavailable" } },
  });
  setAccount.run(4, JSON.stringify({ ...key, revision: 4, state: "deleted" }));
  expect(readSyncBlocker(journal, null)).toMatchObject({
    weighIn: { account: { state: "deleted" } },
  });
  db.exec(`UPDATE edo_sync_outbox SET content =
    json_set(content, '$.pending.content.localDay', '2026-02-29')`);
  expect(readSyncBlocker(journal, null)).toMatchObject({
    weighIn: { phone: { state: "unavailable" } },
  });
});

it("shows a recoverable status when reading the journal fails", async () => {
  using db = new DatabaseSync(":memory:");
  const diary = await open(db);
  const { journal } = diary.sync;
  expect(readSyncBlocker(journal, null)).toEqual({ state: "empty", next: null });
  db.exec(`INSERT INTO edo_sync_binding
    VALUES (1, 'https://example.test', 'account', 'lineage', 2, 1);
    ALTER TABLE edo_sync_outbox RENAME TO unreadable_test_outbox`);
  expect(syncBlockerNotice(journal)).toBe("error");
  expect(readSyncBlocker(journal, null)).toEqual({ state: "error", next: null });
});
