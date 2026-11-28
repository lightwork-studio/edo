import {
  type AuthenticatedHistory,
  assertSession,
  type Change,
  decodeChange,
  decodePullResponse,
  decodeSubmission,
  decodeSubmissionResult,
  isKnownRecordKind,
  maxSyncSubmissions,
  type NegotiatedSync,
  type RecordKey,
  type Submission,
  type SubmissionResult,
  SyncWireError,
  syncScope,
} from "@edo/contract";
import { normalizeSyncServer } from "./client.ts";
import {
  createOutboxRecord,
  type OutboxEdit,
  type OutboxRecord,
  prepareOutboxAttempt,
  queueOutboxEdit,
  receiveOutboxOutcome,
  retryBlockedOutbox,
} from "./outbox.ts";
import { decodeStoredOutbox } from "./stored-outbox.ts";

type Value = string | number | null;
type Row = Record<string, unknown>;

/** Uses the diary's existing SQLite connection so both writes can share the transaction. */
interface JournalSqlite {
  exec(sql: string): void;
  run(sql: string, ...parameters: Value[]): void;
  all(sql: string, ...parameters: Value[]): Row[];
  get(sql: string, ...parameters: Value[]): Row | undefined;
}

export function installSyncJournal(db: JournalSqlite): void {
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
    CREATE TABLE edo_sync_remote (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      content TEXT NOT NULL CHECK (json_valid(content)),
      PRIMARY KEY (kind, id)
    ) WITHOUT ROWID, STRICT;
  `);
}

interface Binding extends Pick<AuthenticatedHistory, "accountBinding" | "lineage" | "revision"> {
  readonly cursor: number;
  readonly server: string;
}

function inTransaction<T>(db: JournalSqlite, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollback) {
      throw new AggregateError([error, rollback], "Could not roll back the sync journal");
    }
    throw error;
  }
}

function savedBinding(db: JournalSqlite): Binding | null {
  const row = db.get(
    "SELECT server, account_binding, lineage, observed_revision, cursor FROM edo_sync_binding",
  );
  if (!row) return null;
  const {
    server,
    account_binding: accountBinding,
    lineage,
    observed_revision: revision,
    cursor,
  } = row;
  if (
    typeof server !== "string" ||
    normalizeSyncServer(server, true) !== server ||
    typeof accountBinding !== "string" ||
    !accountBinding.trim() ||
    typeof lineage !== "string" ||
    !lineage.trim() ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    typeof cursor !== "number" ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    revision < cursor
  ) {
    throw new Error("Stored sync binding is invalid");
  }
  return { accountBinding, lineage, revision, cursor, server };
}

function verifyScope(binding: Binding | null, session: NegotiatedSync): Binding {
  if (!binding || session.accountBinding !== binding.accountBinding) {
    throw new SyncWireError("account-changed", "This diary belongs to a different sync account");
  }
  if (session.lineage !== binding.lineage) {
    throw new SyncWireError("lineage-changed", "This diary has a different server history");
  }
  return binding;
}

function storedRecord(row: Row) {
  const { kind, id, attempt_id: attemptId, attempt_release: release, content } = row;
  if (
    typeof kind !== "string" ||
    typeof id !== "string" ||
    typeof content !== "string" ||
    (attemptId !== null && typeof attemptId !== "string") ||
    (release !== null &&
      (typeof release !== "string" ||
        release.length > 16 ||
        !/^\d+\.\d+(?:\.\d+)?$/.test(release))) ||
    (release === null) !== (attemptId === null)
  ) {
    throw new Error("Stored outbox identity or release is invalid");
  }
  return { record: decodeStoredOutbox(JSON.parse(content), { kind, id }, attemptId), release };
}

function saveRecord(db: JournalSqlite, record: OutboxRecord, release: string | null = null) {
  db.run(
    `INSERT INTO edo_sync_outbox VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(kind,id) DO UPDATE SET attempt_id = excluded.attempt_id,
      attempt_release = excluded.attempt_release, content = excluded.content`,
    record.key.kind,
    record.key.id,
    record.attempt?.submissionId ?? null,
    record.attempt ? release : null,
    JSON.stringify(record),
  );
}

function pinnedRelease(db: JournalSqlite): string | null {
  const rows = db.all(
    "SELECT DISTINCT attempt_release FROM edo_sync_outbox WHERE attempt_id IS NOT NULL LIMIT 2",
  );
  if (rows.length === 0) return null;
  const release = rows[0]?.attempt_release;
  if (rows.length > 1 || typeof release !== "string")
    throw new Error("Incompatible saved outbox releases");
  return release;
}

function remoteRecord(db: JournalSqlite, key: RecordKey): Change | null {
  const row = db.get(
    "SELECT revision, content FROM edo_sync_remote WHERE kind = ? AND id = ?",
    key.kind,
    key.id,
  );
  if (!row || typeof row.content !== "string") return null;
  const record = decodeChange(JSON.parse(row.content));
  if (record.kind !== key.kind || record.id !== key.id || record.revision !== row.revision) {
    throw new Error("Stored remote identity is invalid");
  }
  return record;
}

function localRecord(db: JournalSqlite, key: RecordKey) {
  const row = db.get("SELECT * FROM edo_sync_outbox WHERE kind = ? AND id = ?", key.kind, key.id);
  return row
    ? storedRecord(row)
    : { record: createOutboxRecord(key, remoteRecord(db, key)), release: null };
}

function requireUnusedId(db: JournalSqlite, id: string) {
  if (
    db.get("SELECT submission_id FROM edo_sync_receipts WHERE submission_id = ?", id) ||
    db.get(
      `SELECT id FROM edo_sync_outbox WHERE attempt_id = ?
        OR json_extract(content, '$.pending.submissionId') = ?
        OR json_extract(content, '$.blocked.submission.submissionId') = ? LIMIT 1`,
      id,
      id,
      id,
    )
  ) {
    throw new Error("A new edit cannot reuse a previous submission ID");
  }
}

function hasLocalWork(record: OutboxRecord): boolean {
  return Boolean(record.attempt || record.pending || record.blocked);
}

/** Candidate on-device persistence. Schema installation belongs to the diary migration. */
export function openSyncJournal(db: JournalSqlite) {
  let activeSession: NegotiatedSync | null = null;

  function checkSession(session: NegotiatedSync) {
    if (activeSession !== session)
      throw new SyncWireError("update-required", "Bind the active connection before syncing");
    return verifyScope(savedBinding(db), session);
  }

  return {
    history: () => savedBinding(db),
    requiredRelease: () => pinnedRelease(db),
    bind(session: NegotiatedSync, server: string) {
      assertSession(session);
      const endpoint = normalizeSyncServer(server, true);
      inTransaction(db, () => {
        const binding = savedBinding(db);
        if (binding) {
          if (binding.server !== endpoint)
            throw new SyncWireError(
              "account-changed",
              "This diary belongs to a different sync server",
            );
          verifyScope(binding, session);
          if (session.revision < binding.revision) {
            throw new SyncWireError("cursor-reset", "This account revision moved backwards");
          }
          db.run("UPDATE edo_sync_binding SET observed_revision = ?", session.revision);
        } else {
          db.run(
            "INSERT INTO edo_sync_binding VALUES (1, ?, ?, ?, ?, 0)",
            endpoint,
            session.accountBinding,
            session.lineage,
            session.revision,
          );
        }
      });
      activeSession = session;
    },
    commitLocal(key: RecordKey, edit: OutboxEdit, applyLocal: () => void) {
      return inTransaction(db, () => {
        if (!savedBinding(db))
          throw new Error("Connect this diary before queueing account changes");
        if (!isKnownRecordKind(key.kind))
          throw new Error("This client cannot edit this record kind");
        requireUnusedId(db, edit.submissionId);
        const { record, release } = localRecord(db, key);
        const validated = decodeSubmission({ ...edit, ...key, baseRevision: record.baseRevision });
        const changed = queueOutboxEdit(record, validated);
        applyLocal();
        saveRecord(db, changed, release);
      });
    },
    prepare(session: NegotiatedSync, limit = 32): Submission[] {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxSyncSubmissions) {
        throw new RangeError("Invalid outbox batch size");
      }
      return inTransaction(db, () => {
        checkSession(session);
        assertSession(session, true);
        const required = pinnedRelease(db);
        if (required && required !== session.release) {
          throw new SyncWireError(
            "update-required",
            "Reconnect using the release of the pending submission",
          );
        }
        const rows = db.all(
          `SELECT * FROM edo_sync_outbox
          WHERE attempt_id IS NOT NULL OR (
            json_type(content, '$.pending') = 'object' AND json_type(content, '$.blocked') = 'null'
          ) ORDER BY (attempt_id IS NULL), kind, id LIMIT ?`,
          limit,
        );
        return rows.map((row) => {
          const { record } = storedRecord(row);
          if (!session.writableKinds.includes(record.key.kind)) {
            throw new SyncWireError(
              "update-required",
              "The negotiated release cannot send this pending record",
            );
          }
          const next = prepareOutboxAttempt(record);
          if (!next.attempt) throw new Error("The selected work cannot be sent");
          if (next !== record) saveRecord(db, next, session.release);
          return next.attempt;
        });
      });
    },
    applyResults(
      session: NegotiatedSync,
      outcomes: readonly SubmissionResult[],
      applyRemote: (change: Change) => void,
    ) {
      return inTransaction(db, () => {
        const binding = checkSession(session);
        let revision = binding.revision;
        for (const outcome of outcomes) {
          const result = decodeSubmissionResult(outcome);
          const row = db.get(
            "SELECT * FROM edo_sync_outbox WHERE attempt_id = ?",
            result.submissionId,
          );
          if (!row) {
            if (
              db.get(
                "SELECT submission_id FROM edo_sync_receipts WHERE submission_id = ?",
                result.submissionId,
              )
            )
              continue;
            throw new Error("This receipt has no pending outbox attempt");
          }
          const { record, release } = storedRecord(row);
          if (release !== session.release)
            throw new SyncWireError(
              "update-required",
              "The receipt belongs to another sync release",
            );
          const next = receiveOutboxOutcome(record, result);
          const remote =
            result.status === "accepted" && !hasLocalWork(next)
              ? remoteRecord(db, record.key)
              : null;
          if (
            remote &&
            remote.state !== "unavailable" &&
            remote.revision >= (next.baseRevision ?? 0)
          ) {
            applyRemote(remote);
            saveRecord(db, createOutboxRecord(remote, remote));
          } else {
            saveRecord(db, next, release);
          }
          if (result.status !== "retryable")
            db.run("INSERT INTO edo_sync_receipts VALUES (?)", result.submissionId);
          if (result.status === "accepted") revision = Math.max(revision, result.revision);
          if (result.status === "conflict" && result.current)
            revision = Math.max(revision, result.current.revision);
        }
        db.run("UPDATE edo_sync_binding SET observed_revision = ?", revision);
      });
    },
    applyPage(
      session: NegotiatedSync,
      requestCursor: number,
      input: unknown,
      applyRemote: (change: Change) => void,
    ) {
      const page = decodePullResponse(
        input,
        { ...syncScope(session), cursor: requestCursor },
        session,
      );
      return inTransaction(db, () => {
        const binding = checkSession(session);
        if (binding.cursor !== requestCursor)
          throw new Error("The pull cursor changed before the page was saved");
        for (const change of page.changes) {
          const { record, release } = localRecord(db, change);
          db.run(
            `INSERT INTO edo_sync_remote VALUES (?, ?, ?, ?)
            ON CONFLICT(kind,id) DO UPDATE SET revision = excluded.revision, content = excluded.content
            WHERE excluded.revision > edo_sync_remote.revision`,
            change.kind,
            change.id,
            change.revision,
            JSON.stringify(change),
          );
          if (change.state === "unavailable" || !isKnownRecordKind(change.kind)) continue;
          if (hasLocalWork(record)) {
            if (!record.base && change.revision === record.baseRevision) {
              saveRecord(db, { ...record, base: change }, release);
            }
            continue;
          }
          if (change.revision < (record.baseRevision ?? 0)) continue;
          applyRemote(change);
          saveRecord(db, createOutboxRecord(change, change));
        }
        db.run(
          "UPDATE edo_sync_binding SET cursor = ?, observed_revision = MAX(observed_revision, ?)",
          page.cursor,
          page.cursor,
        );
      });
    },
    retryReviewed(key: RecordKey, seenRevision: number | null, submissionId: string) {
      return inTransaction(db, () => {
        const { record } = localRecord(db, key);
        const server = remoteRecord(db, key);
        if ((server?.revision ?? null) !== seenRevision) {
          throw new Error("The server record changed during review");
        }
        requireUnusedId(db, submissionId);
        saveRecord(db, retryBlockedOutbox(record, server, submissionId));
      });
    },
    queued: () =>
      db
        .all("SELECT * FROM edo_sync_outbox ORDER BY kind, id")
        .map((row) => storedRecord(row).record)
        .filter(hasLocalWork),
    serverCopy: (key: RecordKey) => remoteRecord(db, key),
  };
}
