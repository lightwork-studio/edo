import { installSyncJournalV5 } from "./journal-schema-v5.ts";

/** Install client projection evidence separately from the version 5 server snapshots. */
export function installSyncJournalV6(db: { exec(sql: string): void }): void {
  db.exec(`
    CREATE TABLE edo_sync_meal_projections (
      id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      origin TEXT NOT NULL CHECK (origin IN ('accepted', 'pulled')),
      content TEXT CHECK (content IS NULL OR (
        origin = 'accepted' AND json_valid(content) AND json_type(content) = 'object'
      ))
    ) WITHOUT ROWID, STRICT;
  `);
}

export function installSyncJournal(db: { exec(sql: string): void }): void {
  installSyncJournalV5(db);
  installSyncJournalV6(db);
}
