import { installSyncJournal as installThroughV9 } from "./journal-schema-v9.ts";

/** Record device snapshots verified after applying an incoming weigh-in. */
export function installSyncJournalV10(db: { exec(sql: string): void }): void {
  db.exec(`
    CREATE TABLE edo_sync_applied_weigh_ins (
      id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      content TEXT CHECK (content IS NULL OR (json_valid(content) AND json_type(content) = 'object'))
    ) WITHOUT ROWID, STRICT;
  `);
}

export function installSyncJournal(db: { exec(sql: string): void }): void {
  installThroughV9(db);
  installSyncJournalV10(db);
}
