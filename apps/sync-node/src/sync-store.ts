import { createHash } from "node:crypto";
import { closeSync, openSync, statSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { TextDecoder } from "node:util";
import {
  type AuthenticatedHistory,
  type Change,
  decodeChange,
  decodeHelloResponse,
  decodePullRequest,
  decodePushRequest,
  decodePushResponse,
  type JsonObject,
  type JsonValue,
  maxSyncEnvelopeBytes,
  type NegotiatedSync,
  type PullResponse,
  type PushResponse,
  type RecordKey,
  type Submission,
  type SubmissionResult,
  type SyncScope,
  SyncWireError,
  syncCandidate,
  syncScope,
} from "@edo/contract";
import type { WeighIn } from "@edo/core";
import { isLocalDay, isOccurredAt, isPositiveNumber, isRecordId } from "./record-values.ts";

const applicationId = 0x45444f53;
const schemaVersion = 2;
const defaultPageSize = 100;
// Two escaped 1,024-unit IDs plus release, cursor, and JSON framing fit in this reserve.
const pullEnvelopeReserve = 14 * 1024;

const schema = `
  CREATE TABLE sync_accounts (
    account_binding TEXT PRIMARY KEY NOT NULL,
    lineage TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    restored_lineage TEXT,
    restored_revision INTEGER,
    CHECK ((restored_lineage IS NULL) = (restored_revision IS NULL)),
    CHECK (restored_lineage IS NULL OR restored_lineage != lineage),
    CHECK (restored_revision IS NULL OR restored_revision BETWEEN 0 AND revision)
  ) STRICT;
  CREATE TABLE sync_records (
    account_binding TEXT NOT NULL REFERENCES sync_accounts(account_binding),
    revision INTEGER NOT NULL CHECK (revision > 0),
    kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    content TEXT CHECK (content IS NULL OR json_valid(content)),
    PRIMARY KEY (account_binding, kind, record_id),
    UNIQUE (account_binding, revision)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE sync_receipts (
    account_binding TEXT NOT NULL REFERENCES sync_accounts(account_binding),
    lineage TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    result TEXT NOT NULL CHECK (json_valid(result)),
    PRIMARY KEY (account_binding, lineage, submission_id)
  ) STRICT, WITHOUT ROWID;
`;

const removeStoredMealItemOwners = `
  DELETE FROM sync_meal_item_owners
  WHERE OLD.kind = 'meal' AND account_binding = OLD.account_binding AND meal_id = OLD.record_id;
`;

const insertStoredMealItemOwners = `
  SELECT RAISE(ABORT, 'Invalid stored meal items')
  WHERE NEW.kind = 'meal' AND json_type(NEW.content, '$.items') <> 'array';
  INSERT INTO sync_meal_item_owners (account_binding, item_id, meal_id)
  SELECT NEW.account_binding, CASE
    WHEN items.type = 'object' AND json_type(items.value, '$.id') = 'text'
      THEN json_extract(items.value, '$.id')
    ELSE NULL
  END, NEW.record_id
  FROM json_each(NEW.content, '$.items') AS items
  WHERE NEW.kind = 'meal';
`;

const mealItemOwnershipSchema = `
  CREATE TABLE sync_meal_item_owners (
    account_binding TEXT NOT NULL REFERENCES sync_accounts(account_binding),
    item_id TEXT NOT NULL CHECK (length(trim(item_id)) > 0 AND instr(item_id, char(0)) = 0),
    meal_id TEXT NOT NULL,
    PRIMARY KEY (account_binding, item_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX sync_meal_item_owners_by_meal
    ON sync_meal_item_owners (account_binding, meal_id);
  CREATE TRIGGER sync_claim_inserted_meal_items AFTER INSERT ON sync_records
  WHEN NEW.kind = 'meal' BEGIN
    ${insertStoredMealItemOwners}
  END;
  CREATE TRIGGER sync_replace_updated_meal_items AFTER UPDATE ON sync_records
  WHEN OLD.kind = 'meal' OR NEW.kind = 'meal' BEGIN
    ${removeStoredMealItemOwners}
    ${insertStoredMealItemOwners}
  END;
  CREATE TRIGGER sync_release_deleted_meal_items AFTER DELETE ON sync_records
  WHEN OLD.kind = 'meal' BEGIN
    ${removeStoredMealItemOwners}
  END;
`;

export class InvalidSyncContent extends Error {}

export class InvalidSyncSnapshot extends Error {}

export interface SyncStoreOptions {
  applyContent: (input: {
    key: RecordKey;
    release: string;
    current: JsonObject | null;
    submitted: JsonObject;
  }) => JsonObject;
}

export interface SyncStore extends Disposable {
  createAccount(accountBinding: string, lineage: string): AuthenticatedHistory;
  history(accountBinding: string): AuthenticatedHistory | null;
  /** The caller supplies the account binding from its trusted access context. */
  readWeighIn(accountBinding: string, id: string): (WeighIn & { readonly revision: number }) | null;
  push(accountBinding: string, session: NegotiatedSync, input: unknown): PushResponse;
  pull(accountBinding: string, session: NegotiatedSync, input: unknown): PullResponse;
}

type SqlRow = Record<string, SQLOutputValue>;
type Decision = SubmissionResult | { readonly content: JsonObject | null };

function transaction<T>(db: DatabaseSync, begin: "BEGIN" | "BEGIN IMMEDIATE", fn: () => T): T {
  db.exec(begin);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function initialize(db: DatabaseSync) {
  transaction(db, "BEGIN IMMEDIATE", () => {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    const id = db.prepare("PRAGMA application_id").get()?.application_id;
    if (id === applicationId && version === schemaVersion) return;
    if (id === applicationId && version === 1) {
      db.exec(mealItemOwnershipSchema);
      backfillMealItemOwners(db);
      db.exec(`PRAGMA user_version = ${schemaVersion}`);
      return;
    }
    const existing = db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
    if (id !== 0 || version !== 0 || existing) throw new Error("Unsupported sync database");
    db.exec(schema);
    db.exec(mealItemOwnershipSchema);
    db.exec(`PRAGMA application_id = ${applicationId}; PRAGMA user_version = ${schemaVersion}`);
  });
}

function historyFrom(value: unknown): AuthenticatedHistory {
  const { accountBinding, lineage, revision, restoredFrom } = decodeHelloResponse(value);
  return { accountBinding, lineage, revision, restoredFrom };
}

function storedHistory(row: SqlRow): AuthenticatedHistory {
  return historyFrom({
    release: syncCandidate.release,
    features: [],
    accountBinding: row.account_binding,
    lineage: row.lineage,
    revision: row.revision,
    restoredFrom:
      row.restored_lineage === null
        ? null
        : { lineage: row.restored_lineage, revision: row.restored_revision },
  });
}

function assertAccountBinding(accountBinding: string, session: NegotiatedSync) {
  if (accountBinding !== session.accountBinding) {
    throw new SyncWireError("unauthorized", "The sync session is unavailable for this account");
  }
}

function assertCurrentHistory(history: AuthenticatedHistory | null, session: NegotiatedSync) {
  if (!history) {
    throw new SyncWireError("unauthorized", "The sync session is unavailable for this account");
  }
  if (history.lineage !== session.lineage) {
    throw new SyncWireError("lineage-changed", "The account history changed. Reconnect to sync.");
  }
  if (history.revision < session.revision) {
    throw new SyncWireError(
      "cursor-reset",
      "The account history is older than the negotiated revision",
    );
  }
  return history;
}

function storedChange(row: SqlRow): Change {
  const { kind, record_id: id, revision, content } = row;
  return decodeChange(
    content === null
      ? { kind, id, revision, state: "deleted" }
      : { kind, id, revision, state: "live", content: storedJson(content) },
  );
}

function storedJson(value: SQLOutputValue | undefined): unknown {
  if (typeof value !== "string") throw new Error("Invalid JSON column in the sync database");
  return JSON.parse(value);
}

function mealItemIds(content: JsonObject | null): Set<string> {
  const ids = new Set<string>();
  const items = content?.items;
  if (items === undefined) return ids;
  if (!Array.isArray(items)) throw new InvalidSyncContent("Invalid meal items");
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new InvalidSyncContent("Invalid meal item ID");
    }
    const { id } = item as JsonObject;
    if (
      typeof id !== "string" ||
      !id.trim() ||
      id.includes("\0") ||
      /[\uD800-\uDFFF]/u.test(id) ||
      ids.has(id)
    ) {
      throw new InvalidSyncContent("Invalid or duplicate meal item ID");
    }
    ids.add(id);
  }
  return ids;
}

function backfillMealItemOwners(db: DatabaseSync) {
  const meals = db.prepare(`
    SELECT account_binding, revision, kind, record_id, content FROM sync_records
    WHERE kind = 'meal' AND content IS NOT NULL
  `);
  const claim = db.prepare(`
    INSERT INTO sync_meal_item_owners (account_binding, item_id, meal_id) VALUES (?, ?, ?)
    ON CONFLICT (account_binding, item_id) DO NOTHING
  `);
  for (const row of meals.iterate()) {
    const meal = storedChange(row);
    const accountBinding = row.account_binding;
    if (meal.state !== "live" || typeof accountBinding !== "string") {
      throw new Error("Invalid stored meal while initializing item ownership");
    }
    for (const itemId of mealItemIds(meal.content)) {
      if (claim.run(accountBinding, itemId, meal.id).changes === 0) {
        throw new Error("A stored meal item ID already belongs to another meal");
      }
    }
  }
}

function databaseTextDecoder(db: DatabaseSync): TextDecoder {
  const encoding = db.prepare("PRAGMA main.encoding").get()?.encoding;
  if (typeof encoding !== "string") throw new Error("Invalid sync database encoding");
  return new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
}

function requireStoredText(decoder: TextDecoder, value: unknown, bytes: unknown) {
  if (value === null && bytes === null) return;
  try {
    if (
      typeof value === "string" &&
      bytes instanceof Uint8Array &&
      decoder.decode(bytes) === value
    ) {
      return;
    }
  } catch {
    // SQLite text containing invalid bytes can otherwise decode as a different identity.
  }
  throw new InvalidSyncSnapshot("A stored sync value has invalid text");
}

/** Inspect a standalone copy and report data-free diagnostics. */
export function assertSyncSnapshotConsistency(db: DatabaseSync): void {
  try {
    transaction(db, "BEGIN", () => {
      if (
        db.prepare("PRAGMA main.application_id").get()?.application_id !== applicationId ||
        db.prepare("PRAGMA main.user_version").get()?.user_version !== schemaVersion
      ) {
        throw new InvalidSyncSnapshot("Unsupported sync snapshot format");
      }

      using canonical = new DatabaseSync(":memory:");
      initialize(canonical);
      const schemaObjects = `
        SELECT type, name, tbl_name, sql FROM main.sqlite_schema
        WHERE NOT (type IS 'table' AND tbl_name IS name AND (
          (name IS 'sqlite_stat1' AND sql IS 'CREATE TABLE sqlite_stat1(tbl,idx,stat)') OR
          (name IS 'sqlite_stat4' AND sql IS 'CREATE TABLE sqlite_stat4(tbl,idx,nEq,nLt,nDLt,sample)')
        ))
        ORDER BY type, name`;
      if (
        JSON.stringify(db.prepare(schemaObjects).all()) !==
        JSON.stringify(canonical.prepare(schemaObjects).all())
      ) {
        throw new InvalidSyncSnapshot("Unexpected sync snapshot schema");
      }
      if (
        db.prepare("PRAGMA main.integrity_check(1)").get()?.integrity_check !== "ok" ||
        db.prepare("PRAGMA main.foreign_key_check").get()
      ) {
        throw new InvalidSyncSnapshot("SQLite integrity verification failed");
      }

      const decoder = databaseTextDecoder(db);
      const accounts = db.prepare(`
        SELECT account.*,
          CAST(account_binding AS BLOB) AS account_bytes,
          CAST(lineage AS BLOB) AS lineage_bytes,
          CAST(restored_lineage AS BLOB) AS restored_bytes,
          COALESCE((SELECT MAX(revision) FROM main.sync_records AS record
            WHERE record.account_binding = account.account_binding), 0) AS last_revision
        FROM main.sync_accounts AS account`);
      for (const account of accounts.iterate()) {
        requireStoredText(decoder, account.account_binding, account.account_bytes);
        requireStoredText(decoder, account.lineage, account.lineage_bytes);
        requireStoredText(decoder, account.restored_lineage, account.restored_bytes);
        if ((account.restored_lineage === null) !== (account.restored_revision === null)) {
          throw new InvalidSyncSnapshot("An account restore point is incomplete");
        }
        if (storedHistory(account).revision !== account.last_revision) {
          throw new InvalidSyncSnapshot("An account revision is unreachable by pull");
        }
      }

      const owner = db.prepare(`
        SELECT 1 AS found FROM main.sync_meal_item_owners
        WHERE account_binding = ? AND item_id = ? AND meal_id = ?`);
      const records = db.prepare(`
        SELECT account_binding, revision, kind, record_id, content,
          CAST(kind AS BLOB) AS kind_bytes, CAST(record_id AS BLOB) AS id_bytes,
          CAST(content AS BLOB) AS content_bytes FROM main.sync_records`);
      let expectedClaims = 0;
      for (const row of records.iterate()) {
        requireStoredText(decoder, row.kind, row.kind_bytes);
        requireStoredText(decoder, row.record_id, row.id_bytes);
        requireStoredText(decoder, row.content, row.content_bytes);
        const record = storedChange(row);
        if (!fitsPullPage(record)) {
          throw new InvalidSyncSnapshot("A stored record exceeds the pull page limit");
        }
        if (record.kind !== "meal" || record.state !== "live") continue;
        const accountBinding = row.account_binding;
        if (typeof accountBinding !== "string") {
          throw new InvalidSyncSnapshot("A meal has an invalid account binding");
        }
        for (const itemId of mealItemIds(record.content)) {
          if (owner.get(accountBinding, itemId, record.id)?.found !== 1) {
            throw new InvalidSyncSnapshot("A meal item ownership claim is missing or wrong");
          }
          expectedClaims += 1;
        }
      }
      const count = db.prepare("SELECT COUNT(*) AS count FROM main.sync_meal_item_owners").get();
      if (count?.count !== expectedClaims) {
        throw new InvalidSyncSnapshot("A meal item ownership claim has no matching record");
      }
    });
  } catch (error) {
    if (error instanceof InvalidSyncSnapshot) throw error;
    throw new InvalidSyncSnapshot("Sync snapshot contains invalid or unreadable records");
  }
}

function orderedJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(orderedJson);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, orderedJson(child)]),
  );
}

function canonicalJson(value: JsonValue): string {
  return JSON.stringify(orderedJson(value));
}

function selectPullPage(
  rows: Iterable<SqlRow>,
  limit: number,
  cursor: number,
): {
  cursor: number;
  changes: Change[];
  hasMore: boolean;
} {
  const changes: Change[] = [];
  let bytes = pullEnvelopeReserve;
  for (const row of rows) {
    if (changes.length === limit) return { cursor, changes, hasMore: true };
    const change = storedChange(row);
    bytes += Buffer.byteLength(JSON.stringify(change)) + 1;
    if (bytes > maxSyncEnvelopeBytes) {
      if (!changes.length) throw new Error("Stored sync change exceeds the pull page limit");
      return { cursor, changes, hasMore: true };
    }
    changes.push(change);
    cursor = change.revision;
  }
  return { cursor, changes, hasMore: false };
}

function boundPushResponse(scope: SyncScope, results: SubmissionResult[]): PushResponse {
  let bytes =
    Buffer.byteLength(JSON.stringify({ ...scope, results: [] })) + Math.max(0, results.length - 1);
  const possible: { index: number; saving: number; compacted: SubmissionResult }[] = [];
  for (const [index, result] of results.entries()) {
    const size = Buffer.byteLength(JSON.stringify(result));
    bytes += size;
    if (result.status === "conflict" && result.current?.state === "live") {
      const { kind, id, revision } = result.current;
      const compacted: SubmissionResult = {
        ...result,
        current: { kind, id, revision, state: "unavailable" },
      };
      possible.push({
        index,
        compacted,
        saving: size - Buffer.byteLength(JSON.stringify(compacted)),
      });
    }
  }
  if (bytes > maxSyncEnvelopeBytes) {
    // Keep full results in the receipts. Compact the largest live copies first on the wire.
    possible.sort((a, b) => b.saving - a.saving || a.index - b.index);
    for (const { index, compacted, saving } of possible) {
      if (saving <= 0 || bytes <= maxSyncEnvelopeBytes) break;
      results[index] = compacted;
      bytes -= saving;
    }
    if (bytes > maxSyncEnvelopeBytes) {
      throw new SyncWireError(
        "invalid-request",
        "The sync response is too large. Send a smaller batch.",
      );
    }
  }
  return { ...scope, results };
}

function invalidContent(submissionId: string, message: string): SubmissionResult {
  return {
    status: "rejected",
    submissionId,
    code: "invalid-content",
    message: message.trim().slice(0, 1000) || "The submitted record is invalid",
  };
}

function fitsPullPage(change: Change): boolean {
  return (
    Buffer.byteLength(JSON.stringify(change)) + pullEnvelopeReserve + 1 <= maxSyncEnvelopeBytes
  );
}

function decide(
  submission: Submission,
  current: Change | null,
  release: string,
  applyContent: SyncStoreOptions["applyContent"],
): Decision {
  const { kind, id, submissionId, baseRevision } = submission;
  const accepted = (revision: number): SubmissionResult => ({
    status: "accepted",
    submissionId,
    revision,
  });
  const conflict = (reason: "stale" | "deleted" | "exists"): SubmissionResult => ({
    status: "conflict",
    submissionId,
    reason,
    current,
  });
  const currentRevision = current?.revision ?? null;
  if (baseRevision !== null && currentRevision === null) return conflict("stale");
  const expected = baseRevision === currentRevision;
  if (submission.op === "delete") {
    if (current?.state === "deleted") return accepted(current.revision);
    if (!expected) return conflict("stale");
    if (!fitsPullPage({ state: "deleted", kind, id, revision: Number.MAX_SAFE_INTEGER })) {
      return invalidContent(submissionId, "The submitted record ID is too large to sync");
    }
    return { content: null };
  }
  if (current?.state === "deleted" && (kind !== "favorite" || !expected)) {
    return conflict("deleted");
  }

  let content: JsonObject;
  try {
    const storedContent = current?.state === "live" ? current.content : null;
    content = applyContent({
      key: { kind, id },
      release,
      current: storedContent,
      submitted: submission.content,
    });
  } catch (error) {
    if (!(error instanceof InvalidSyncContent)) throw error;
    if (!expected) return conflict(baseRevision === null ? "exists" : "stale");
    return invalidContent(submissionId, error.message);
  }

  const candidate = decodeChange({
    state: "live",
    kind,
    id,
    revision: Number.MAX_SAFE_INTEGER,
    content,
  });
  if (candidate.state !== "live") throw new Error("Expected a live sync record");
  if (
    current?.state === "live" &&
    canonicalJson(current.content) === canonicalJson(candidate.content)
  ) {
    return accepted(current.revision);
  }
  if (!expected) return conflict(baseRevision === null ? "exists" : "stale");
  if (!fitsPullPage(candidate)) {
    return invalidContent(submissionId, "The submitted record is too large to sync");
  }
  return { content: candidate.content };
}

function preparePrivateFile(filename: string) {
  if (filename === ":memory:") return;
  if (!filename) throw new Error("A sync database filename is required");
  try {
    closeSync(openSync(filename, "ax", 0o600));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  if (process.platform !== "win32" && (statSync(filename).mode & 0o077) !== 0) {
    throw new Error("A sync database must have private file permissions");
  }
}

/** The candidate keeps full terminal receipts indefinitely. Retention needs a deployment policy. */
export function openSyncStore(filename: string, { applyContent }: SyncStoreOptions): SyncStore {
  if (typeof applyContent !== "function")
    throw new TypeError("Sync storage needs record validation");
  preparePrivateFile(filename);
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON");
    initialize(db);

    const insertAccount = db.prepare(
      "INSERT INTO sync_accounts (account_binding, lineage) VALUES (?, ?)",
    );
    const readHistory = db.prepare(`
      SELECT account_binding, lineage, revision, restored_lineage, restored_revision
      FROM sync_accounts WHERE account_binding = ?
    `);
    const setRevision = db.prepare(
      "UPDATE sync_accounts SET revision = ? WHERE account_binding = ?",
    );
    const writeRecord = db.prepare(`
      INSERT INTO sync_records (account_binding, revision, kind, record_id, content)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (account_binding, kind, record_id) DO UPDATE SET
        revision = excluded.revision, content = excluded.content
    `);
    const currentRecord = db.prepare(`
      SELECT revision, kind, record_id, content FROM sync_records
      WHERE account_binding = ? AND kind = ? AND record_id = ?
    `);
    const currentWeighIn = db.prepare(`
      SELECT record.revision, record.kind, record.record_id,
        typeof(record.content) AS content_type,
        CAST(record.content AS BLOB) AS content,
        account.revision AS account_revision
      FROM main.sync_records AS record
      LEFT JOIN main.sync_accounts AS account ON account.account_binding = record.account_binding
      WHERE record.account_binding = ? AND record.kind = 'weigh-in' AND record.record_id = ?
    `);
    currentWeighIn.setReadBigInts(true);
    const textDecoder = databaseTextDecoder(db);
    const recordRevision = db.prepare(`
      SELECT revision FROM sync_records WHERE account_binding = ? AND kind = ? AND record_id = ?
    `);
    const changesAfter = db.prepare(`
      SELECT revision, kind, record_id, content FROM sync_records
      WHERE account_binding = ? AND revision > ? ORDER BY revision LIMIT ?
    `);
    const findReceipt = db.prepare(`
      SELECT digest, result FROM sync_receipts
      WHERE account_binding = ? AND lineage = ? AND submission_id = ?
    `);
    const insertReceipt = db.prepare(`
      INSERT INTO sync_receipts (account_binding, lineage, submission_id, digest, result) VALUES (?, ?, ?, ?, ?)
    `);
    const itemOwner = db.prepare(`
      SELECT meal_id FROM sync_meal_item_owners WHERE account_binding = ? AND item_id = ?
    `);
    // Record triggers update the index atomically. Preflight reports a typed rejection.
    function assertMealItemsAvailable(accountBinding: string, mealId: string, content: JsonObject) {
      for (const itemId of mealItemIds(content)) {
        const owner = itemOwner.get(accountBinding, itemId);
        if (owner && owner.meal_id !== mealId) {
          throw new InvalidSyncContent("A meal item ID already belongs to another meal");
        }
      }
    }

    function history(accountBinding: string): AuthenticatedHistory | null {
      const row = readHistory.get(accountBinding);
      return row ? storedHistory(row) : null;
    }

    return {
      createAccount(accountBinding, lineage) {
        const account = historyFrom({
          release: syncCandidate.release,
          features: [],
          accountBinding,
          lineage,
          revision: 0,
          restoredFrom: null,
        });
        insertAccount.run(account.accountBinding, account.lineage);
        return account;
      },
      history,
      readWeighIn(accountBinding, id) {
        if (!isRecordId(accountBinding) || !isRecordId(id) || id.length > maxSyncEnvelopeBytes) {
          return null;
        }
        const row = currentWeighIn.get(accountBinding, id);
        if (!row || row.content === null) return null;
        let change: Change;
        try {
          const {
            content,
            content_type: contentType,
            revision,
            account_revision: accountRevision,
          } = row;
          if (
            contentType !== "text" ||
            !(content instanceof Uint8Array) ||
            typeof revision !== "bigint" ||
            typeof accountRevision !== "bigint" ||
            accountRevision < revision ||
            !Number.isSafeInteger(Number(accountRevision))
          ) {
            throw new TypeError("Invalid stored representation");
          }
          change = storedChange({
            ...row,
            revision: Number(revision),
            content: textDecoder.decode(content),
          });
        } catch {
          throw new Error("Invalid stored weigh-in");
        }
        if (change.state !== "live") throw new Error("Invalid stored weigh-in");
        const { id: contentId, localDay, occurredAt, kg } = change.content;
        if (
          contentId !== id ||
          !isLocalDay(localDay) ||
          !isOccurredAt(occurredAt) ||
          !isPositiveNumber(kg)
        ) {
          throw new Error("Invalid stored weigh-in");
        }
        return { id, revision: change.revision, localDay, occurredAt, kg };
      },
      push(accountBinding, session, input) {
        assertAccountBinding(accountBinding, session);
        const request = decodePushRequest(input, session);
        const { release, lineage } = request;
        return transaction(db, "BEGIN IMMEDIATE", () => {
          const account = assertCurrentHistory(history(accountBinding), session);
          // A submission's base must have existed before any writes in this batch.
          for (const { baseRevision, kind, id } of request.submissions) {
            if (baseRevision === null) continue;
            const initialRevision = recordRevision.get(accountBinding, kind, id)?.revision;
            if (
              baseRevision > account.revision ||
              (typeof initialRevision === "number" && baseRevision > initialRevision)
            ) {
              throw new SyncWireError(
                "cursor-reset",
                "The submission base is ahead of the stored record history",
              );
            }
          }
          let revision = account.revision;
          const results = request.submissions.map((submission): SubmissionResult => {
            const { kind, id, submissionId } = submission;
            const digest = createHash("sha256")
              .update(canonicalJson({ release, ...submission }))
              .digest("hex");
            const receipt = findReceipt.get(accountBinding, lineage, submissionId);
            if (receipt) {
              if (receipt.digest === digest) return storedJson(receipt.result) as SubmissionResult;
              return {
                status: "rejected",
                submissionId,
                code: "submission-reused",
                message: "This submission ID already has a different payload",
              };
            }
            const stored = currentRecord.get(accountBinding, kind, id);
            let decision = decide(
              submission,
              stored ? storedChange(stored) : null,
              release,
              applyContent,
            );
            if ("content" in decision && kind === "meal" && decision.content !== null) {
              try {
                assertMealItemsAvailable(accountBinding, id, decision.content);
              } catch (error) {
                if (!(error instanceof InvalidSyncContent)) throw error;
                decision = invalidContent(submissionId, error.message);
              }
            }
            let result: SubmissionResult;
            if ("content" in decision) {
              revision += 1;
              if (!Number.isSafeInteger(revision))
                throw new Error("Sync revisions have been exhausted");
              writeRecord.run(
                accountBinding,
                revision,
                kind,
                id,
                decision.content === null ? null : JSON.stringify(decision.content),
              );
              result = { status: "accepted", submissionId, revision };
            } else {
              result = decision;
            }
            insertReceipt.run(
              accountBinding,
              lineage,
              submissionId,
              digest,
              JSON.stringify(result),
            );
            return result;
          });
          if (revision !== account.revision) setRevision.run(revision, accountBinding);
          return decodePushResponse(
            boundPushResponse(syncScope(session), results),
            request,
            session,
          );
        });
      },
      pull(accountBinding, session, input) {
        assertAccountBinding(accountBinding, session);
        const { cursor, limit = defaultPageSize } = decodePullRequest(input, session);
        return transaction(db, "BEGIN", () => {
          const account = assertCurrentHistory(history(accountBinding), session);
          if (cursor > account.revision) {
            throw new SyncWireError(
              "cursor-reset",
              "The sync cursor is ahead of this account history",
            );
          }
          const rows = changesAfter.iterate(accountBinding, cursor, limit + 1);
          return { ...syncScope(session), ...selectPullPage(rows, limit, cursor) };
        });
      },
      [Symbol.dispose]: () => db[Symbol.dispose](),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
