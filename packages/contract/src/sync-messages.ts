import {
  assertSession,
  type NegotiatedSync,
  type RecordKind,
  type Revision,
  readRevision,
  readToken,
  recordKinds,
} from "./negotiation.ts";
import {
  choice,
  fields,
  invalid,
  type JsonObject,
  readContent,
  readId,
  readList,
  readText,
  type SyncErrorCode,
  SyncWireError,
  safeInteger,
  syncErrorCodes,
} from "./wire-values.ts";

export const maxSyncSubmissions = 100;
export const maxSyncPage = 500;
// A transport checks these bytes before calling the decoders, which operate on parsed JSON.
export const maxSyncEnvelopeBytes = 1024 * 1024;

export interface RecordKey {
  readonly kind: string;
  readonly id: string;
}

export interface SyncScope {
  readonly release: string;
  readonly lineage: string;
}

type Mutation = RecordKey & {
  readonly submissionId: string;
  readonly baseRevision: Revision | null;
};

export type Submission =
  | (Mutation & { readonly op: "put"; readonly content: JsonObject })
  | (Mutation & { readonly op: "delete" });

type VersionedRecord = RecordKey & { readonly revision: Revision };

export type Change =
  | (VersionedRecord & { readonly state: "live"; readonly content: JsonObject })
  | (VersionedRecord & { readonly state: "deleted" | "unavailable" });

export type ConflictReason = "stale" | "deleted" | "exists";
export type RejectedCode = "invalid-content" | "submission-reused";
export type RetryableReason = "temporarily-unavailable";

type Receipt = { readonly submissionId: string };

export type SubmissionResult = Receipt &
  (
    | { readonly status: "accepted"; readonly revision: Revision }
    | {
        readonly status: "conflict";
        readonly reason: ConflictReason;
        readonly current: Change | null;
      }
    | { readonly status: "rejected"; readonly code: RejectedCode; readonly message: string }
    | { readonly status: "retryable"; readonly reason: RetryableReason }
  );

export interface PushRequest extends SyncScope {
  readonly submissions: readonly Submission[];
}

export interface PushResponse extends SyncScope {
  readonly results: readonly SubmissionResult[];
}

export interface PullRequest extends SyncScope {
  readonly cursor: Revision;
  readonly limit?: number;
}

export interface PullResponse extends SyncScope {
  readonly cursor: Revision;
  readonly hasMore: boolean;
  readonly changes: readonly Change[];
}

export interface SyncErrorResponse {
  readonly error: { readonly code: SyncErrorCode; readonly message: string };
}

export function decodeSyncError(input: unknown): SyncErrorResponse {
  const body = fields(input, "failure response", ["error"]);
  const error = fields(body.error, "failure", ["code", "message"]);
  return {
    error: {
      code: choice(error.code, syncErrorCodes, "error code"),
      message: readText(error.message, 1000, "error message"),
    },
  };
}

export function isKnownRecordKind(kind: string): kind is RecordKind {
  return recordKinds.some((known) => known === kind);
}

/** Source IDs stay strings. A length-sensitive JSON pair keeps provider namespaces distinct. */
export function favoriteRecordId(provider: string, sourceId: string): string {
  const pair = [readToken(provider, "favorite provider"), readId(sourceId, "favorite source ID")];
  return readId(JSON.stringify(pair), "favorite record ID");
}

function readKey(body: Record<string, unknown>): RecordKey {
  const kind = readToken(body.kind, "record kind");
  const id = readId(body.id, "record ID");
  if (kind === "favorite") {
    let pair: unknown;
    try {
      pair = JSON.parse(id);
    } catch {
      return invalid("favorite record ID");
    }
    if (!Array.isArray(pair) || pair.length !== 2 || favoriteRecordId(pair[0], pair[1]) !== id) {
      return invalid("favorite record ID");
    }
  }
  return { kind, id };
}

function readScope(body: Record<string, unknown>, session: NegotiatedSync): SyncScope {
  if (body.release !== session.release) {
    throw new SyncWireError("update-required", "The message uses an unnegotiated sync release");
  }
  if (readId(body.lineage, "lineage") !== session.lineage) {
    throw new SyncWireError(
      "lineage-changed",
      "The message belongs to a different account history",
    );
  }
  return { release: session.release, lineage: session.lineage };
}

function readSubmission(input: unknown, session: NegotiatedSync): Submission {
  const tag = fields(input, "submission");
  const op = choice(tag.op, ["put", "delete"], "submission operation");
  const keys = ["op", "submissionId", "kind", "id", "baseRevision"];
  const body = fields(input, "submission", op === "put" ? [...keys, "content"] : keys);
  const key = readKey(body);
  if (!session.writableKinds.includes(key.kind)) return invalid("submission record kind");
  const mutation = {
    ...key,
    submissionId: readId(body.submissionId, "submission ID"),
    baseRevision:
      body.baseRevision === null ? null : readRevision(body.baseRevision, "base revision"),
  };
  return op === "put"
    ? { ...mutation, op, content: readContent(body.content) }
    : { ...mutation, op };
}

export function decodePushRequest(input: unknown, session: NegotiatedSync): PushRequest {
  assertSession(session, true);
  const body = fields(input, "push request", ["release", "lineage", "submissions"]);
  const scope = readScope(body, session);
  const submissions = readList(body.submissions, maxSyncSubmissions, "submissions", (entry) =>
    readSubmission(entry, session),
  );
  if (
    !submissions.length ||
    new Set(submissions.map(({ submissionId }) => submissionId)).size !== submissions.length
  ) {
    return invalid("submission batch");
  }
  return { ...scope, submissions };
}

/** Unknown future kinds are retained as opaque revisioned records for the client. */
export function decodeChange(input: unknown): Change {
  const tag = fields(input, "change");
  const state = choice(tag.state, ["live", "deleted", "unavailable"], "record state");
  const keys = ["state", "kind", "id", "revision"];
  const body = fields(input, "change", state === "live" ? [...keys, "content"] : keys);
  const record = { ...readKey(body), revision: readRevision(body.revision, "record revision") };
  return state === "live"
    ? { ...record, state, content: readContent(body.content) }
    : { ...record, state };
}

function readResult(input: unknown): SubmissionResult {
  const tag = fields(input, "submission result");
  const status = choice(
    tag.status,
    ["accepted", "conflict", "rejected", "retryable"],
    "submission outcome",
  );
  const submissionId = readId(tag.submissionId, "submission ID");
  const keys = ["status", "submissionId"];
  switch (status) {
    case "accepted": {
      const body = fields(input, "accepted result", [...keys, "revision"]);
      return { status, submissionId, revision: readRevision(body.revision, "accepted revision") };
    }
    case "conflict": {
      const body = fields(input, "conflict result", [...keys, "reason", "current"]);
      const reason = choice(body.reason, ["stale", "deleted", "exists"], "conflict reason");
      const current = body.current === null ? null : decodeChange(body.current);
      if (
        (reason === "deleted" && current?.state !== "deleted") ||
        (reason === "exists" && (!current || current.state === "deleted"))
      ) {
        return invalid("current conflict copy");
      }
      return { status, submissionId, reason, current };
    }
    case "rejected": {
      const body = fields(input, "rejected result", [...keys, "code", "message"]);
      return {
        status,
        submissionId,
        code: choice(body.code, ["invalid-content", "submission-reused"], "rejection code"),
        message: readText(body.message, 1000, "rejection message"),
      };
    }
    case "retryable": {
      const body = fields(input, "retryable result", [...keys, "reason"]);
      return {
        status,
        submissionId,
        reason: choice(body.reason, ["temporarily-unavailable"], "retryable reason"),
      };
    }
  }
}

export function decodePushResponse(
  input: unknown,
  request: PushRequest,
  session: NegotiatedSync,
): PushResponse {
  assertSession(session, true);
  readScope({ ...request }, session);
  const body = fields(input, "push response", ["release", "lineage", "results"]);
  const scope = readScope(body, session);
  const results = readList(body.results, maxSyncSubmissions, "submission results", readResult);
  if (results.length !== request.submissions.length) return invalid("submission result count");
  for (const [index, result] of results.entries()) {
    const submission = request.submissions[index];
    if (!submission || result.submissionId !== submission.submissionId) {
      return invalid("submission result ID or order");
    }
    if (
      result.status === "accepted" &&
      submission.baseRevision !== null &&
      result.revision < submission.baseRevision
    ) {
      return invalid("accepted revision before the submission base");
    }
    if (
      result.status === "conflict" &&
      result.current &&
      (result.current.kind !== submission.kind || result.current.id !== submission.id)
    ) {
      return invalid("conflict record identity");
    }
  }
  return { ...scope, results };
}

export function decodePullRequest(input: unknown, session: NegotiatedSync): PullRequest {
  assertSession(session);
  const body = fields(input, "pull request", ["release", "lineage", "cursor", "limit"]);
  const scope = readScope(body, session);
  return {
    ...scope,
    cursor: readRevision(body.cursor, "pull cursor", true),
    ...(Object.hasOwn(body, "limit") && {
      limit: safeInteger(body.limit, 1, maxSyncPage, "pull limit"),
    }),
  };
}

export function decodePullResponse(
  input: unknown,
  request: PullRequest,
  session: NegotiatedSync,
): PullResponse {
  assertSession(session);
  readScope({ ...request }, session);
  const body = fields(input, "pull response", [
    "release",
    "lineage",
    "cursor",
    "hasMore",
    "changes",
  ]);
  const scope = readScope(body, session);
  const cursor = readRevision(body.cursor, "next cursor", true);
  const hasMore = body.hasMore;
  if (
    typeof hasMore !== "boolean" ||
    cursor < request.cursor ||
    (hasMore && cursor === request.cursor)
  ) {
    return invalid("pull page cursor");
  }
  const changes = readList(body.changes, request.limit ?? maxSyncPage, "changes", decodeChange);
  let last = request.cursor;
  for (const change of changes) {
    if (change.revision <= last || change.revision > cursor)
      return invalid("pull change revision or order");
    last = change.revision;
  }
  if (last !== cursor) return invalid("unrepresented pull revisions");
  return { ...scope, cursor, hasMore, changes };
}
