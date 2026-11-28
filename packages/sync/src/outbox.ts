import {
  type Change,
  type JsonObject,
  type JsonValue,
  type RecordKey,
  type Revision,
  type Submission,
  type SubmissionResult,
  SyncWireError,
} from "@edo/contract";

export type OutboxEdit =
  | { readonly submissionId: string; readonly op: "put"; readonly content: JsonObject }
  | { readonly submissionId: string; readonly op: "delete" };

type BlockingOutcome = Extract<SubmissionResult, { status: "conflict" | "rejected" }>;

export interface OutboxRecord {
  readonly key: RecordKey;
  readonly baseRevision: Revision | null;
  /** Last observed server snapshot, when available at the expected revision. */
  readonly base: Change | null;
  readonly pending: OutboxEdit | null;
  readonly attempt: Submission | null;
  readonly blocked: {
    readonly submission: Submission;
    readonly result: BlockingOutcome;
  } | null;
}

function snapshotJson(value: JsonObject): JsonObject;
function snapshotJson(value: JsonValue): JsonValue;
function snapshotJson(value: JsonValue): JsonValue {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) return Object.freeze(value.map(snapshotJson));
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, field]) => [key, snapshotJson(field)])),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Outbox content must contain finite numbers");
  }
  return value;
}

function revisionIsValid(revision: Revision): boolean {
  return Number.isSafeInteger(revision) && revision > 0;
}

function snapshotChange(key: RecordKey, change: Change | null): Change | null {
  if (change === null) return null;
  if (change.kind !== key.kind || change.id !== key.id || !revisionIsValid(change.revision)) {
    throw new TypeError("Outbox evidence belongs to a different record or has an invalid revision");
  }
  return Object.freeze(
    change.state === "live" ? { ...change, content: snapshotJson(change.content) } : { ...change },
  );
}

export function createOutboxRecord(key: RecordKey, base: Change | null = null): OutboxRecord {
  return {
    key: Object.freeze({ kind: key.kind, id: key.id }),
    baseRevision: base?.revision ?? null,
    base: snapshotChange(key, base),
    pending: null,
    attempt: null,
    blocked: null,
  };
}

function requireNewSubmissionId(record: OutboxRecord, submissionId: string) {
  if (
    !submissionId.trim() ||
    [
      record.pending?.submissionId,
      record.attempt?.submissionId,
      record.blocked?.submission.submissionId,
    ].includes(submissionId)
  ) {
    throw new TypeError("An outbox edit requires a new submission ID");
  }
}

/** Queue the latest local edit while preserving any sent payload and its receipt ID. */
export function queueOutboxEdit(record: OutboxRecord, edit: OutboxEdit): OutboxRecord {
  requireNewSubmissionId(record, edit.submissionId);
  const { op, submissionId } = edit;
  const pending =
    op === "put" ? { op, submissionId, content: snapshotJson(edit.content) } : { op, submissionId };
  return { ...record, pending: Object.freeze(pending) };
}

/** Persist the returned record before sending its attempt. An existing attempt is ready to retry. */
export function prepareOutboxAttempt(record: OutboxRecord): OutboxRecord {
  if (record.attempt || record.blocked || !record.pending) return record;
  const { kind, id } = record.key;
  const { op, submissionId } = record.pending;
  const meta = { kind, id, submissionId, baseRevision: record.baseRevision };
  const attempt = Object.freeze(
    op === "put" ? { ...meta, op, content: snapshotJson(record.pending.content) } : { ...meta, op },
  );
  return { ...record, attempt, pending: null };
}

export function receiveOutboxOutcome(record: OutboxRecord, result: SubmissionResult): OutboxRecord {
  const attempt = record.attempt;
  if (!attempt || result.submissionId !== attempt.submissionId) {
    throw new Error("The receipt does not match the in-flight outbox attempt");
  }
  if (result.status === "retryable") return record;
  if (result.status === "accepted") {
    if (!revisionIsValid(result.revision) || result.revision < (attempt.baseRevision ?? 0)) {
      throw new Error("The receipt has an invalid accepted revision");
    }
    return {
      ...record,
      baseRevision: result.revision,
      // A delete receipt proves a tombstone. Live content can include server-preserved fields.
      base:
        attempt.op === "delete"
          ? snapshotChange(record.key, {
              ...record.key,
              state: "deleted",
              revision: result.revision,
            })
          : record.base?.revision === result.revision
            ? record.base
            : null,
      attempt: null,
    };
  }
  if (
    result.status === "conflict" &&
    result.current &&
    attempt.baseRevision !== null &&
    result.current.revision < attempt.baseRevision
  ) {
    throw new SyncWireError("cursor-reset", "The server record moved behind the submission base");
  }
  const evidence =
    result.status === "conflict"
      ? { ...result, current: snapshotChange(record.key, result.current) }
      : { ...result };
  return {
    ...record,
    attempt: null,
    blocked: Object.freeze({ submission: attempt, result: Object.freeze(evidence) }),
  };
}

/** Explicitly keep the latest local edit after reviewing the current server record. */
export function retryBlockedOutbox(
  record: OutboxRecord,
  base: Change | null,
  submissionId: string,
): OutboxRecord {
  if (!record.blocked) throw new Error("There is no blocked outbox attempt to retry");
  const reviewed = snapshotChange(record.key, base);
  const { submission, result } = record.blocked;
  const observedRevision = result.status === "conflict" ? result.current?.revision : undefined;
  const minimumRevision = Math.max(record.baseRevision ?? 0, observedRevision ?? 0);
  if (reviewed?.state === "unavailable" || (reviewed?.revision ?? 0) < minimumRevision) {
    throw new Error("Review the current server record before retrying a blocked edit");
  }
  const edit = record.pending ?? submission;
  if (reviewed?.state === "deleted" && edit.op === "put" && record.key.kind !== "favorite") {
    throw new Error("A deleted record requires a new record ID");
  }
  const queued = queueOutboxEdit(record, { ...edit, submissionId });
  return { ...queued, baseRevision: reviewed?.revision ?? null, base: reviewed, blocked: null };
}
