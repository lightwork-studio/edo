import { chmod, link, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { inspectSyncSnapshot, syncDatabaseVersion } from "./sync-store.ts";

export function verifySyncBackup(filename: string) {
  using database = new DatabaseSync(filename, { readOnly: true });
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
