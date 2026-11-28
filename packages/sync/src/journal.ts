import {
  type AuthenticatedHistory,
  assertSession,
  type Change,
  decodeChange,
  decodePullResponse,
  decodeSubmission,
  decodeSubmissionResult,
  isKnownRecordKind,
  type JsonObject,
  maxSyncSubmissions,
  type NegotiatedSync,
  type PullResponse,
  type PushResponse,
  type RecordKey,
  type Submission,
  SyncWireError,
  syncScope,
} from "@edo/contract";
import {
  assertReceiptMatchesAttempt,
  assertResponseSession,
  maxSyncRequestBytes,
  normalizeSyncServer,
  serverForSession,
  syncRequestBytes,
} from "./client.ts";
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

interface Binding extends Pick<AuthenticatedHistory, "accountBinding" | "lineage" | "revision"> {
  readonly cursor: number;
  readonly server: string;
}

function inTransaction<T>(
  db: JournalSqlite,
  begin: "BEGIN" | "BEGIN IMMEDIATE",
  operation: () => T,
): T {
  db.exec(begin);
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
  if (row) return storedRecord(row);
  const remote = remoteRecord(db, key);
  const base = remote?.state === "unavailable" ? null : remote;
  return { record: createOutboxRecord(key, base), release: null };
}

function requireUnusedId(db: JournalSqlite, id: string) {
  if (db.get("SELECT submission_id FROM edo_sync_submission_ids WHERE submission_id = ?", id)) {
    throw new Error("A new edit cannot reuse a previous submission ID");
  }
  db.run("INSERT INTO edo_sync_submission_ids VALUES (?)", id);
}

function reserveLocalEdit(db: JournalSqlite, key: RecordKey, submissionId: string) {
  if (!savedBinding(db)) throw new Error("Connect this diary before queueing account changes");
  if (!isKnownRecordKind(key.kind)) throw new Error("This client cannot edit this record kind");
  requireUnusedId(db, submissionId);
  return localRecord(db, key);
}

type ProjectedEdit = { op: "put"; content: unknown } | { op: "delete" };

interface StalePutEvidence {
  readonly base: JsonObject;
  readonly draft: JsonObject;
  readonly server: JsonObject;
}

function orderedJson(content: JsonObject): string {
  return JSON.stringify(content, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const fields = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(fields)
        .sort()
        .map((name) => [name, fields[name]]),
    );
  });
}

function hasLocalWork(record: OutboxRecord): boolean {
  return Boolean(record.attempt || record.pending || record.blocked);
}

function requireSynchronousWrite(result: undefined): void {
  if (result !== undefined) throw new TypeError("Diary writes must complete synchronously");
}

/** Candidate on-device persistence. Schema installation belongs to the diary migration. */
export function openSyncJournal(db: JournalSqlite, requireCurrentStorage?: () => void) {
  let activeSession: NegotiatedSync | null = null;

  function transact<T>(
    operation: () => T,
    begin: "BEGIN" | "BEGIN IMMEDIATE" = "BEGIN IMMEDIATE",
  ): T {
    return inTransaction(db, begin, () => {
      requireCurrentStorage?.();
      return operation();
    });
  }

  function inspect<T>(operation: () => T): T {
    return requireCurrentStorage ? transact(operation, "BEGIN") : operation();
  }

  function checkSession(session: NegotiatedSync) {
    if (activeSession !== session)
      throw new SyncWireError("update-required", "Bind the active connection before syncing");
    serverForSession(session);
    return verifyScope(savedBinding(db), session);
  }

  return {
    history: () => inspect(() => savedBinding(db)),
    requiredRelease: () => inspect(() => pinnedRelease(db)),
    bind(session: NegotiatedSync) {
      assertSession(session);
      const endpoint = serverForSession(session);
      transact(() => {
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
    commitLocal(key: RecordKey, edit: OutboxEdit, applyLocal: () => undefined) {
      return transact(() => {
        const { record, release } = reserveLocalEdit(db, key, edit.submissionId);
        const validated = decodeSubmission({ ...edit, ...key, baseRevision: record.baseRevision });
        const changed = queueOutboxEdit(record, validated);
        requireSynchronousWrite(applyLocal());
        saveRecord(db, changed, release);
      });
    },
    /** Queue the persisted result of a synchronous local write on the same connection. */
    commitLocalProjection(key: RecordKey, submissionId: string, applyLocal: () => ProjectedEdit) {
      return transact(() => {
        const { record, release } = reserveLocalEdit(db, key, submissionId);
        const edit = applyLocal();
        if (edit?.op !== "put" && edit?.op !== "delete") {
          throw new TypeError("A diary write must synchronously return its projected edit");
        }
        const validated = decodeSubmission({
          ...edit,
          ...key,
          submissionId,
          baseRevision: record.baseRevision,
        });
        saveRecord(db, queueOutboxEdit(record, validated), release);
      });
    },
    prepare(session: NegotiatedSync, limit = 32): Submission[] {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxSyncSubmissions) {
        throw new RangeError("Invalid outbox batch size");
      }
      return transact(() => {
        checkSession(session);
        assertSession(session, true);
        const required = pinnedRelease(db);
        if (required && required !== session.release) {
          throw new SyncWireError(
            "update-required",
            "Reconnect using the release of the pending submission",
          );
        }
        const emptyBytes = syncRequestBytes(
          JSON.stringify({ ...syncScope(session), submissions: [] }),
        );
        let bytes = emptyBytes;
        let skippedOversized = false;
        let skippedUnsupported = false;
        const batch: { attempt: Submission; save: OutboxRecord | null }[] = [];
        scan: for (let offset = 0; batch.length < limit; offset += limit) {
          const rows = db.all(
            `SELECT * FROM edo_sync_outbox
            WHERE attempt_id IS NOT NULL OR (
              json_type(content, '$.pending') = 'object' AND json_type(content, '$.blocked') = 'null'
            ) ORDER BY (attempt_id IS NULL), kind, id LIMIT ? OFFSET ?`,
            limit,
            offset,
          );
          for (const row of rows) {
            const { record } = storedRecord(row);
            if (!session.writableKinds.includes(record.key.kind)) {
              skippedUnsupported = true;
              continue;
            }
            const next = prepareOutboxAttempt(record);
            if (!next.attempt) throw new Error("The selected work cannot be sent");
            const size = syncRequestBytes(JSON.stringify(next.attempt));
            if (emptyBytes + size > maxSyncRequestBytes) {
              skippedOversized = true;
              continue;
            }
            const separator = batch.length ? 1 : 0;
            if (bytes + separator + size > maxSyncRequestBytes) break scan;
            bytes += separator + size;
            batch.push({ attempt: next.attempt, save: next === record ? null : next });
            if (batch.length === limit) break scan;
          }
          if (rows.length < limit) break;
        }
        if (!batch.length && skippedUnsupported) {
          throw new SyncWireError(
            "update-required",
            "The negotiated release cannot send this pending record",
          );
        }
        if (!batch.length && skippedOversized) {
          throw new SyncWireError("invalid-request", "A pending edit is too large to sync");
        }
        return batch.map(({ attempt, save }) => {
          if (save) saveRecord(db, save, session.release);
          return attempt;
        });
      });
    },
    applyResults(
      session: NegotiatedSync,
      response: PushResponse,
      applyRemote: (change: Change) => undefined,
    ) {
      return transact(() => {
        const binding = checkSession(session);
        assertResponseSession(response, session);
        let revision = binding.revision;
        for (const outcome of response.results) {
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
          if (!record.attempt) throw new Error("This receipt has no pending outbox attempt");
          assertReceiptMatchesAttempt(response, record.attempt);
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
            const projected = createOutboxRecord(remote, remote);
            requireSynchronousWrite(applyRemote(remote));
            saveRecord(db, projected);
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
      input: PullResponse,
      applyRemote: (change: Change) => undefined,
    ) {
      assertResponseSession(input, session, requestCursor);
      const page = decodePullResponse(
        input,
        { ...syncScope(session), cursor: requestCursor },
        session,
      );
      return transact(() => {
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
          const projected = createOutboxRecord(change, change);
          requireSynchronousWrite(applyRemote(change));
          saveRecord(db, projected);
        }
        db.run(
          "UPDATE edo_sync_binding SET cursor = ?, observed_revision = MAX(observed_revision, ?)",
          page.cursor,
          page.cursor,
        );
      });
    },
    retryReviewed(
      key: RecordKey,
      seenRevision: number | null,
      seenSubmissionId: string,
      submissionId: string,
    ) {
      return transact(() => {
        const { record } = localRecord(db, key);
        const server = remoteRecord(db, key);
        if ((server?.revision ?? null) !== seenRevision) {
          throw new Error("The server record changed during review");
        }
        const draft = record.pending ?? record.blocked?.submission;
        if (draft?.submissionId !== seenSubmissionId) {
          throw new Error("The local edit changed during review");
        }
        requireUnusedId(db, submissionId);
        const retried = retryBlockedOutbox(record, server, submissionId);
        decodeSubmission({ ...retried.pending, ...key, baseRevision: retried.baseRevision });
        saveRecord(db, retried);
      });
    },
    /** Rebase a blocked put and commit its merged diary value. A null result declines the rebase. */
    tryRebaseStalePut(
      session: NegotiatedSync,
      key: RecordKey,
      submissionId: string,
      resolve: (evidence: StalePutEvidence) => unknown,
      writeMerged: (content: JsonObject) => undefined,
    ): boolean {
      return transact(() => {
        checkSession(session);
        assertSession(session, true);
        if (!isKnownRecordKind(key.kind) || !session.writableKinds.includes(key.kind)) return false;

        const { record } = localRecord(db, key);
        const { base, blocked } = record;
        const draft = record.pending ?? blocked?.submission;
        const server = remoteRecord(db, key);
        if (
          record.attempt ||
          !blocked ||
          blocked.result.status !== "conflict" ||
          blocked.result.reason !== "stale" ||
          blocked.submission.op !== "put" ||
          draft?.op !== "put" ||
          base?.state !== "live" ||
          server?.state !== "live" ||
          base.revision !== record.baseRevision ||
          base.revision !== blocked.submission.baseRevision ||
          server.revision <= base.revision
        ) {
          return false;
        }
        const current = blocked.result.current;
        if (!current || current.state === "deleted" || server.revision < current.revision)
          return false;
        if (
          current.revision === server.revision &&
          current.state === "live" &&
          orderedJson(current.content) !== orderedJson(server.content)
        ) {
          return false;
        }

        const rebased = createOutboxRecord(key, server);
        const content = resolve({
          base: base.content,
          draft: draft.content,
          server: server.content,
        });
        if (content === null) return false;
        const replacement = decodeSubmission({
          ...key,
          op: "put",
          content,
          submissionId,
          baseRevision: server.revision,
        });
        const bytes = syncRequestBytes(
          JSON.stringify({ ...syncScope(session), submissions: [replacement] }),
        );
        if (bytes > maxSyncRequestBytes) return false;

        requireUnusedId(db, submissionId);
        const queued = queueOutboxEdit(rebased, replacement);
        if (queued.pending?.op !== "put") throw new Error("Expected a rebased put");
        requireSynchronousWrite(writeMerged(queued.pending.content));
        saveRecord(db, queued);
        return true;
      });
    },
    queued: () =>
      inspect(() =>
        db
          .all("SELECT * FROM edo_sync_outbox ORDER BY kind, id")
          .map((row) => storedRecord(row).record)
          .filter(hasLocalWork),
      ),
    serverCopy: (key: RecordKey) => inspect(() => remoteRecord(db, key)),
  };
}
