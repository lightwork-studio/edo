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
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
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
