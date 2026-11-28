import { constants, lstatSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { assertSyncSnapshotConsistency, InvalidSyncSnapshot } from "./sync-store.ts";

function requireStandalonePath(path: string) {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    if (lstatSync(`${path}${suffix}`, { throwIfNoEntry: false })) {
      throw new InvalidSyncSnapshot("The sync snapshot has a SQLite sidecar");
    }
  }
}

export async function verifySyncSnapshot(filename: string): Promise<void> {
  const selected = lstatSync(filename, { bigint: true });
  if (!selected.isFile() || selected.nlink !== 1n) {
    throw new InvalidSyncSnapshot("Expected a regular sync snapshot with a single link");
  }
  const path = await realpath(filename);
  requireStandalonePath(path);
  await using file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  const before = await file.stat({ bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.dev !== selected.dev ||
    before.ino !== selected.ino
  ) {
    throw new InvalidSyncSnapshot("The sync snapshot changed before verification");
  }
  const header = Buffer.alloc(20);
  const { bytesRead } = await file.read(header, 0, header.length, 0);
  if (
    bytesRead !== header.length ||
    !header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) ||
    header[18] !== 1 ||
    header[19] !== 1
  ) {
    throw new InvalidSyncSnapshot("Expected a standalone rollback-journal SQLite snapshot");
  }

  const url = pathToFileURL(path);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  using db = new DatabaseSync(url.href, { readOnly: true });
  db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF");
  assertSyncSnapshotConsistency(db);
  requireStandalonePath(path);
  const after = lstatSync(path, { bigint: true });
  if (
    !after.isFile() ||
    after.nlink !== 1n ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs
  ) {
    throw new InvalidSyncSnapshot("The sync snapshot changed during verification");
  }
}

if (import.meta.main) {
  try {
    const [filename, ...extra] = process.argv.slice(2);
    if (!filename || extra.length) {
      throw new InvalidSyncSnapshot("Usage: verify-snapshot <standalone sync snapshot>");
    }
    await verifySyncSnapshot(filename);
    console.log("Sync snapshot passed verification");
  } catch (error) {
    console.error(
      error instanceof InvalidSyncSnapshot ? error.message : "Could not read the sync snapshot",
    );
    process.exitCode = 1;
  }
}
