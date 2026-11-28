import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeSubmission, negotiateHello, type Submission, syncScope } from "@edo/contract";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createSyncBackup, verifySyncBackup } from "../src/backup.ts";
import { applyRecordContent } from "../src/record-projection.ts";
import { openSyncStore, type SyncStore } from "../src/sync-store.ts";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "edo-sync-backup-test-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function put(id: string, submissionId: string, kg: number): Submission {
  return decodeSubmission({
    id,
    kind: "weigh-in",
    op: "put",
    submissionId,
    baseRevision: null,
    content: { id, localDay: "2026-11-27", occurredAt: Date.parse("2026-11-27T12:00Z"), kg },
  });
}

function push(store: SyncStore, account: string, submission: Submission) {
  const history = store.history(account);
  if (!history) throw new Error("Missing the fixture account");
  const reply = negotiateHello({ releases: ["0.1"], features: ["write-records"] }, history);
  if (reply.status !== "ready") throw new Error("Missing the fixture connection");
  return store.push(account, reply.session, {
    ...syncScope(reply.session),
    submissions: [submission],
  });
}

test("verifies a standalone snapshot of an active store and keeps its receipt and tombstone", async () => {
  const live = join(directory, "live.sqlite");
  const destination = join(directory, "backup.sqlite");
  using writer = openSyncStore(live, { applyContent: applyRecordContent });
  {
    using connection = new DatabaseSync(live);
    connection.exec("PRAGMA journal_mode = WAL");
  }
  writer.createAccount("account-a", "lineage-a");
  writer.createAccount("account-b", "lineage-b");
  const old = put("removed", "a-1", 80);
  const first = push(writer, "account-a", old);
  expect(first.results).toMatchObject([{ status: "accepted", revision: 1 }]);
  expect(
    push(
      writer,
      "account-a",
      decodeSubmission({
        id: old.id,
        kind: "weigh-in",
        op: "delete",
        baseRevision: 1,
        submissionId: "a-2",
      }),
    ).results,
  ).toMatchObject([{ status: "accepted", revision: 2 }]);
  push(writer, "account-b", put("other", "b-1", 60));

  const copying = createSyncBackup(live, destination);
  await new Promise<void>((finish) => setImmediate(finish));
  expect(push(writer, "account-a", put("during", "a-3", 81)).results).toMatchObject([
    { status: "accepted", revision: 3 },
  ]);
  const result = await copying;
  expect(result).toMatchObject({
    path: destination,
    schemaVersion: 2,
    accounts: [
      { accountBinding: "account-a", lineage: "lineage-a", restoredFrom: null },
      { accountBinding: "account-b", lineage: "lineage-b", revision: 1, restoredFrom: null },
    ],
  });
  const savedRevision = result.accounts[0]?.revision;
  expect([2, 3]).toContain(savedRevision);
  expect(push(writer, "account-a", put("after-copy", "a-4", 82)).results).toMatchObject([
    { status: "accepted", revision: 4 },
  ]);
  expect(verifySyncBackup(destination)).toEqual({
    schemaVersion: result.schemaVersion,
    accounts: result.accounts,
  });
  if (process.platform !== "win32") {
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
  }

  {
    using snapshot = new DatabaseSync(destination, { readOnly: true });
    expect(snapshot.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
    expect(
      snapshot
        .prepare("SELECT content, revision FROM sync_records WHERE record_id = 'removed'")
        .get(),
    ).toEqual({ content: null, revision: 2 });
    expect(
      snapshot.prepare("SELECT record_id FROM sync_records WHERE record_id = 'during'").get(),
    ).toEqual(savedRevision === 3 ? { record_id: "during" } : undefined);
    expect(
      snapshot.prepare("SELECT 1 FROM sync_records WHERE record_id = 'after-copy'").get(),
    ).toBeUndefined();
  }
  using reopened = openSyncStore(destination, { applyContent: applyRecordContent });
  expect(push(reopened, "account-a", old)).toEqual(first);
  expect(reopened.history("account-a")?.revision).toBe(savedRevision);
  expect(writer.history("account-a")?.revision).toBe(4);
});

test("does not replace an existing backup or publish a corrupt or unrelated SQLite source", async () => {
  const source = join(directory, "live.sqlite");
  const destination = join(directory, "existing.sqlite");
  using live = openSyncStore(source, { applyContent: applyRecordContent });
  live.createAccount("account", "lineage");
  await writeFile(destination, "keep the existing backup");
  await expect(createSyncBackup(source, destination)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(destination, "utf8")).toBe("keep the existing backup");

  const unrelated = join(directory, "unrelated.sqlite");
  {
    using database = new DatabaseSync(unrelated);
    database.exec("CREATE TABLE notes (message TEXT)");
  }
  const next = join(directory, "next.sqlite");
  await expect(createSyncBackup(unrelated, next)).rejects.toThrow(/Unsupported sync database/);
  const corrupt = join(directory, "corrupt.sqlite");
  await writeFile(corrupt, "not an SQLite file");
  await expect(createSyncBackup(corrupt, next)).rejects.toThrow();
  expect(() => verifySyncBackup(corrupt)).toThrow();
  await expect(stat(next)).rejects.toMatchObject({ code: "ENOENT" });
  expect(verifySyncBackup(source).accounts).toMatchObject([
    { accountBinding: "account", revision: 0 },
  ]);
});
