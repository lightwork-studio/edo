/** Install the fixed schema used by diary storage version 5. Evolve it in later migrations. */
export function installSyncJournalV5(db: { exec(sql: string): void }): void {
  db.exec(`
    CREATE TABLE edo_sync_binding (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      server TEXT NOT NULL,
      account_binding TEXT NOT NULL,
      lineage TEXT NOT NULL,
      observed_revision INTEGER NOT NULL CHECK (observed_revision >= 0),
      cursor INTEGER NOT NULL CHECK (cursor >= 0 AND cursor <= observed_revision)
    ) STRICT;
    CREATE TABLE edo_sync_outbox (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      attempt_id TEXT UNIQUE,
      attempt_release TEXT,
      content TEXT NOT NULL CHECK (json_valid(content)),
      CHECK ((attempt_id IS NULL) = (attempt_release IS NULL)),
      PRIMARY KEY (kind, id)
    ) WITHOUT ROWID, STRICT;
    CREATE TABLE edo_sync_receipts (
      submission_id TEXT PRIMARY KEY NOT NULL
    ) WITHOUT ROWID, STRICT;
    CREATE TABLE edo_sync_submission_ids (
      submission_id TEXT PRIMARY KEY NOT NULL
    ) WITHOUT ROWID, STRICT;
    CREATE TABLE edo_sync_remote (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      content TEXT NOT NULL CHECK (json_valid(content)),
      PRIMARY KEY (kind, id)
    ) WITHOUT ROWID, STRICT;
  `);
}
