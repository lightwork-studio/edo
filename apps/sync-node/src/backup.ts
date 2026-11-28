import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { chmod, link, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { inspectSyncSnapshot, syncDatabaseVersion } from "./sync-store.ts";

function requireNoSqliteSidecars(filename: string) {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    if (lstatSync(`${filename}${suffix}`, { throwIfNoEntry: false })) {
      throw new Error("Sync backup path has a SQLite sidecar");
    }
  }
}

function requireRollbackJournalHeader(filename: string) {
  const header = Buffer.alloc(20);
  const fd = openSync(filename, "r");
  try {
    // SQLite can create WAL sidecars even on a read-only connection. Check its read and write
    // format bytes before opening the connection. Both are 1 for a rollback-journal database.
    if (
      readSync(fd, header, 0, header.length, 0) !== header.length ||
      !header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) ||
      header[18] !== 1 ||
      header[19] !== 1
    ) {
      throw new Error("Sync backup must be a standalone SQLite file");
    }
  } finally {
    closeSync(fd);
  }
}

export function verifySyncBackup(filename: string) {
  const snapshot = resolve(filename);
  requireNoSqliteSidecars(snapshot);
  requireRollbackJournalHeader(snapshot);
  using database = new DatabaseSync(snapshot, { readOnly: true });
  if (database.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") {
    throw new Error("Sync backup must be a standalone SQLite file");
  }
  return inspectSyncSnapshot(database);
}

export async function createSyncBackup(source: string, destination: string) {
  const target = resolve(destination);
  const directory = await mkdtemp(join(dirname(target), ".edo-sync-backup-"));
  try {
    const snapshot = join(directory, "snapshot.sqlite");
    {
      using database = new DatabaseSync(source, { readOnly: true });
      database.exec("PRAGMA busy_timeout = 1000");
      syncDatabaseVersion(database);
      await backup(database, snapshot);
    }
    {
      using database = new DatabaseSync(snapshot);
      database.exec("PRAGMA journal_mode = DELETE");
    }
    await chmod(snapshot, 0o600);
    const verified = verifySyncBackup(snapshot);
    requireNoSqliteSidecars(target);
    // Publish the complete verified file with an atomic no-overwrite operation.
    await link(snapshot, target);
    return { path: target, ...verified };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [command, source, destination, ...extra] = process.argv.slice(2);
  if (command === "create" && source && destination && extra.length === 0) {
    console.log(JSON.stringify(await createSyncBackup(source, destination)));
  } else if (command === "verify" && source && destination === undefined) {
    console.log(JSON.stringify(verifySyncBackup(source)));
  } else {
    throw new Error("Usage: backup create <source> <destination> | backup verify <backup>");
  }
}
