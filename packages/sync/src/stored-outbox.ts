import {
  type Change,
  decodeChange,
  decodeSubmission,
  decodeSubmissionResult,
  type RecordKey,
  type Revision,
  type Submission,
  SyncWireError,
} from "@edo/contract";
import type { OutboxEdit, OutboxRecord } from "./outbox.ts";

function invalid(field: string): never {
  throw new TypeError(`Invalid stored outbox ${field}`);
}

function fields(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(label);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid(label);
  if (required.some((name) => !Object.hasOwn(value, name))) return invalid(label);
  for (const name of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, name);
    if (
      typeof name !== "string" ||
      (!required.includes(name) && !optional.includes(name)) ||
      !property?.enumerable ||
      !("value" in property)
    ) {
      return invalid(label);
    }
  }
  return value as Record<string, unknown>;
}

function isRecordKey(value: RecordKey, expected: RecordKey): boolean {
  return value.kind === expected.kind && value.id === expected.id;
}

function storedRevision(value: unknown): Revision | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return invalid("base revision");
  }
  return value;
}

function storedBase(input: unknown, key: RecordKey, baseRevision: Revision | null): Change | null {
  if (input === null) return null;
  const base = decodeChange(input);
  if (!isRecordKey(base, key) || base.revision !== baseRevision) return invalid("base");
  return base;
}

function storedPending(
  input: unknown,
  key: RecordKey,
  baseRevision: Revision | null,
): OutboxEdit | null {
  if (input === null) return null;
  const pending = fields(input, "pending edit", ["op", "submissionId"], ["content"]);
  const edit = decodeSubmission({ ...key, baseRevision, ...pending });
  const { op, submissionId } = edit;
  return op === "put" ? { op, submissionId, content: edit.content } : { op, submissionId };
}

function storedSubmission(
  input: unknown,
  key: RecordKey,
  baseRevision: Revision | null,
): Submission {
  const submission = decodeSubmission(input);
  if (!isRecordKey(submission, key) || submission.baseRevision !== baseRevision) {
    return invalid("submission target or base");
  }
  return submission;
}

function storedBlocked(
  input: unknown,
  key: RecordKey,
  baseRevision: Revision | null,
): OutboxRecord["blocked"] {
  if (input === null) return null;
  const blocked = fields(input, "blocked attempt", ["submission", "result"]);
  const submission = storedSubmission(blocked.submission, key, baseRevision);
  const result = decodeSubmissionResult(blocked.result);
  if (
    (result.status !== "conflict" && result.status !== "rejected") ||
    result.submissionId !== submission.submissionId
  ) {
    return invalid("blocked receipt");
  }
  if (result.status === "conflict" && result.current && !isRecordKey(result.current, key)) {
    return invalid("conflict record");
  }
  return { submission, result };
}

/** Decode the JSON body against the identity and attempt ID stored in the SQLite row. */
export function decodeStoredOutbox(
  input: unknown,
  expectedKey: RecordKey,
  attemptId: string | null,
): OutboxRecord {
  try {
    const record = fields(input, "record", [
      "key",
      "baseRevision",
      "base",
      "pending",
      "attempt",
      "blocked",
    ]);
    const { kind, id } = fields(record.key, "record key", ["kind", "id"]);
    if (
      typeof kind !== "string" ||
      typeof id !== "string" ||
      !isRecordKey({ kind, id }, expectedKey)
    ) {
      return invalid("record key");
    }
    const key = { kind, id };
    const baseRevision = storedRevision(record.baseRevision);
    const base = storedBase(record.base, key, baseRevision);
    const attempt =
      record.attempt === null ? null : storedSubmission(record.attempt, key, baseRevision);
    if ((attempt?.submissionId ?? null) !== attemptId) return invalid("attempt ID");
    const pending = storedPending(record.pending, key, baseRevision);
    const blocked = storedBlocked(record.blocked, key, baseRevision);
    if (attempt && blocked) return invalid("active and blocked attempts");
    const active = attempt ?? blocked?.submission;
    if (pending && active?.submissionId === pending.submissionId)
      return invalid("duplicate submission ID");
    return { key, baseRevision, base, pending, attempt, blocked };
  } catch (error) {
    if (error instanceof SyncWireError) {
      throw new TypeError("Invalid stored outbox payload", { cause: error });
    }
    throw error;
  }
}
