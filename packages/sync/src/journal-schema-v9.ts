import { installSyncJournal as installThroughV8 } from "./journal-schema-v8.ts";

/** Retain displaced account snapshots until the attempt that could use them receives a receipt. */
export function installSyncJournalV9(db: { exec(sql: string): void }): void {
  db.exec(`
    CREATE TABLE edo_sync_attempt_observations (
      submission_id TEXT NOT NULL REFERENCES edo_sync_outbox(attempt_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      content TEXT NOT NULL CHECK (json_valid(content)),
      PRIMARY KEY (submission_id, revision)
    ) WITHOUT ROWID, STRICT;
  `);
}

export function installSyncJournal(db: { exec(sql: string): void }): void {
  installThroughV8(db);
  installSyncJournalV9(db);
}
