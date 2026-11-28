import { File, Paths } from "expo-file-system";
import type { SQLiteDatabase } from "expo-sqlite";

export const journalTables = [
  "edo_sync_binding",
  "edo_sync_outbox",
  "edo_sync_receipts",
  "edo_sync_remote",
  "edo_sync_submission_ids",
];

let interrupt = false;

export function enableInterruption() {
  interrupt = true;
}

export function recoveryMarker(name: string) {
  return new File(Paths.document, `edo-recovery-${name}`);
}

export function publishRecoveryMarker(name: string, text = "ok") {
  const staged = recoveryMarker(`${name}.partial`);
  staged.create({ overwrite: true });
  staged.writeSync(text);
  staged.moveSync(recoveryMarker(name), { overwrite: true });
}

export function pauseBeforeMigrationCommit(db: SQLiteDatabase, sql: string) {
  if (!interrupt || sql !== "PRAGMA user_version = 5") return;
  const version = db.getFirstSync<{ user_version: number }>("PRAGMA user_version");
  const tables = db.getAllSync<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE name GLOB 'edo_sync_*' ORDER BY name",
  );
  if (
    version?.user_version !== 5 ||
    JSON.stringify(tables.map(({ name }) => name)) !== JSON.stringify(journalTables)
  ) {
    throw new Error("The native writer did not reach the final uncommitted v5 step");
  }

  publishRecoveryMarker("parked");
  // The host terminates this process while SQLite still owns its write transaction.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // Keep this synchronous callback from returning to the migration COMMIT.
  }
  throw new Error("The host did not terminate the interrupted migration");
}
