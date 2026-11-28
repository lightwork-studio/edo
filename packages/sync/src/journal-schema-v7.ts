import { installSyncJournal as installThroughV6 } from "./journal-schema-v6.ts";

/** Install durable ownership observations for records that are still waiting to be projected. */
export function installSyncJournalV7(db: { exec(sql: string): void }): void {
  db.exec(`
    CREATE TABLE edo_sync_staged_meal_claims (
      id TEXT PRIMARY KEY NOT NULL,
      item_ids TEXT NOT NULL CHECK (json_valid(item_ids) AND json_type(item_ids) = 'array'),
      unknown_prior INTEGER NOT NULL CHECK (unknown_prior IN (0, 1)),
      CHECK (unknown_prior = 1 OR json_array_length(item_ids) > 0)
    ) WITHOUT ROWID, STRICT;
  `);
}

export function installSyncJournal(db: { exec(sql: string): void }): void {
  installThroughV6(db);
  installSyncJournalV7(db);
}
