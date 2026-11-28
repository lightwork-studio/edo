import { installSyncJournal as installThroughV7 } from "./journal-schema-v7.ts";

/** Preserve effective local weigh-in values after the server accepts their submission. */
export function installSyncJournalV8(db: { exec(sql: string): void }): void {
  db.exec(`
    CREATE TABLE edo_sync_weigh_in_projections (
      id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      content TEXT CHECK (content IS NULL OR (json_valid(content) AND json_type(content) = 'object'))
    ) WITHOUT ROWID, STRICT;
  `);
}

export function installSyncJournal(db: { exec(sql: string): void }): void {
  installThroughV7(db);
  installSyncJournalV8(db);
}
