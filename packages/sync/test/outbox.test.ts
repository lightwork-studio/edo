import { type Change, favoriteRecordId } from "@edo/contract";
import { describe, expect, it } from "vitest";
import {
  createOutboxRecord,
  type OutboxRecord,
  prepareOutboxAttempt,
  queueOutboxEdit,
  receiveOutboxOutcome,
  retryBlockedOutbox,
} from "../src/outbox.ts";

const key = { kind: "meal", id: "meal-1" };
const original: Change = { ...key, revision: 4, state: "live", content: { name: "Breakfast" } };
const firstEdit = {
  op: "put",
  submissionId: "send-first",
  content: { name: "Morning meal" },
} as const;

function roundTrip(record: OutboxRecord): OutboxRecord {
  return JSON.parse(JSON.stringify(record));
}

function firstAttempt() {
  return prepareOutboxAttempt(queueOutboxEdit(createOutboxRecord(key, original), firstEdit));
}

describe("per-record outbox", () => {
  it("retries the saved attempt after restart and uses its accepted revision for a newer edit", () => {
    const sent = firstAttempt();
    expect(sent.attempt).toEqual({ ...key, ...firstEdit, baseRevision: 4 });
    expect(sent.pending).toBeNull();

    const later = { op: "delete", submissionId: "send-second" } as const;
    const restarted = roundTrip(queueOutboxEdit(sent, later));
    expect(prepareOutboxAttempt(restarted)).toBe(restarted);
    expect(restarted.attempt).toEqual(sent.attempt);
    expect(restarted.pending).toEqual(later);
    expect(
      receiveOutboxOutcome(restarted, {
        status: "retryable",
        submissionId: firstEdit.submissionId,
        reason: "temporarily-unavailable",
      }),
    ).toBe(restarted);

    const accepted = receiveOutboxOutcome(restarted, {
      status: "accepted",
      submissionId: firstEdit.submissionId,
      revision: 6,
    });
    expect(accepted).toEqual({
      key,
      baseRevision: 6,
      base: null,
      pending: later,
      attempt: null,
      blocked: null,
    });
    expect(prepareOutboxAttempt(roundTrip(accepted)).attempt).toEqual({
      ...key,
      ...later,
      baseRevision: 6,
    });
  });

  it("takes a separate copy of a mutable local draft and preserves its nested JSON values", () => {
    const mutableKey = { ...key };
    const content = { items: [{ id: "item-1", calories: 0, protein: null }] };
    const record = queueOutboxEdit(createOutboxRecord(mutableKey), {
      op: "put",
      submissionId: "new-meal",
      content,
    });
    mutableKey.id = "other";
    content.items.splice(0, 1, { id: "item-2", calories: 20, protein: null });

    const sent = prepareOutboxAttempt(record);
    expect(sent.attempt).toEqual({
      ...key,
      op: "put",
      submissionId: "new-meal",
      baseRevision: null,
      content: { items: [{ id: "item-1", calories: 0, protein: null }] },
    });
    expect(prepareOutboxAttempt(roundTrip(sent)).attempt).toEqual(sent.attempt);
  });

  it("detaches a sent payload from a draft just read from storage", () => {
    const queued = queueOutboxEdit(createOutboxRecord(key), firstEdit);
    const stored = JSON.parse(JSON.stringify(queued));
    const sent = prepareOutboxAttempt(stored);
    stored.pending.content.name = "Changed hydrated draft";
    expect(sent.attempt).toEqual({ ...key, ...firstEdit, baseRevision: null });
  });

  it("keeps original and server conflict evidence alongside the latest draft until explicit retry", () => {
    const later = {
      op: "put",
      submissionId: "later-draft",
      content: { name: "My latest meal" },
    } as const;
    const state = queueOutboxEdit(firstAttempt(), later);
    const current = {
      ...key,
      revision: 7,
      state: "live",
      content: { name: "Server meal" },
    } as const;
    const result = {
      status: "conflict",
      reason: "stale",
      submissionId: firstEdit.submissionId,
      current,
    } as const;
    const blocked = roundTrip(receiveOutboxOutcome(state, result));
    expect(blocked).toEqual({
      key,
      baseRevision: original.revision,
      base: original,
      attempt: null,
      pending: later,
      blocked: { submission: state.attempt, result },
    });
    expect(prepareOutboxAttempt(blocked)).toBe(blocked);
    expect(() => retryBlockedOutbox(blocked, original, "resolve-old-conflict")).toThrow(
      /review the current server record/i,
    );
    expect(() => retryBlockedOutbox(blocked, current, firstEdit.submissionId)).toThrow(
      /new submission ID/i,
    );
    const retried = retryBlockedOutbox(blocked, current, "resolved-meal");
    expect(retried.blocked).toBeNull();
    expect(retried.base).toEqual(current);
    expect(prepareOutboxAttempt(retried).attempt).toEqual({
      ...key,
      ...later,
      submissionId: "resolved-meal",
      baseRevision: current.revision,
    });
  });

  it("holds rejected edits for review and preserves later corrections", () => {
    const sent = firstAttempt();
    const reject = {
      status: "rejected",
      submissionId: firstEdit.submissionId,
      code: "invalid-content",
      message: "The plan requires a meal name",
    } as const;
    const blocked = receiveOutboxOutcome(sent, reject);
    const corrected = queueOutboxEdit(blocked, {
      op: "put",
      submissionId: "draft-correction",
      content: { name: "Corrected meal" },
    });
    const resumed = roundTrip(corrected);
    expect(prepareOutboxAttempt(resumed)).toBe(resumed);
    expect(resumed.blocked).toEqual({ submission: sent.attempt, result: reject });
    expect(() => retryBlockedOutbox(resumed, null, "reviewed-correction")).toThrow(
      /review the current server record/i,
    );
    expect(
      prepareOutboxAttempt(retryBlockedOutbox(resumed, original, "reviewed-correction")).attempt,
    ).toEqual({
      ...key,
      op: "put",
      submissionId: "reviewed-correction",
      content: { name: "Corrected meal" },
      baseRevision: original.revision,
    });
  });

  it("rejects the wrong receipt, receipt revision, record evidence, or reused active ID", () => {
    const sent = firstAttempt();
    expect(() =>
      receiveOutboxOutcome(sent, { status: "accepted", submissionId: "unknown", revision: 5 }),
    ).toThrow(/does not match/i);
    expect(() =>
      receiveOutboxOutcome(sent, {
        status: "accepted",
        submissionId: firstEdit.submissionId,
        revision: 3,
      }),
    ).toThrow(/invalid accepted revision/i);
    expect(() =>
      receiveOutboxOutcome(sent, {
        status: "conflict",
        reason: "stale",
        submissionId: firstEdit.submissionId,
        current: { ...original, id: "other" },
      }),
    ).toThrow(/different record/i);
    expect(() =>
      queueOutboxEdit(sent, { op: "delete", submissionId: firstEdit.submissionId }),
    ).toThrow(/new submission ID/i);
    expect(sent.attempt).toEqual({ ...key, ...firstEdit, baseRevision: original.revision });
    const accepted = receiveOutboxOutcome(sent, {
      status: "accepted",
      submissionId: firstEdit.submissionId,
      revision: 4,
    });
    expect(accepted.base).toEqual(original);
    expect(accepted.attempt).toBeNull();
  });

  it("keeps an edit against a tombstone available for recovery under a different record ID", () => {
    const tombstone = { ...key, state: "deleted", revision: 8 } as const;
    const blocked = receiveOutboxOutcome(firstAttempt(), {
      status: "conflict",
      reason: "deleted",
      submissionId: firstEdit.submissionId,
      current: tombstone,
    });
    const restored = roundTrip(blocked);
    expect(() => retryBlockedOutbox(restored, tombstone, "try-tombstone")).toThrow(
      /new record ID/i,
    );
    expect(restored.blocked?.submission).toMatchObject(firstEdit);
    expect(prepareOutboxAttempt(restored)).toBe(restored);
  });

  it("can re-add the same favourite after reviewing its deletion", () => {
    const content = { provider: "local", sourceId: "food-1" };
    const key = { kind: "favorite", id: favoriteRecordId(content.provider, content.sourceId) };
    const base: Change = { ...key, revision: 4, state: "live", content };
    const deleted: Change = { ...key, revision: 5, state: "deleted" };
    const attempt = prepareOutboxAttempt(
      queueOutboxEdit(createOutboxRecord(key, base), { op: "put", submissionId: "saved", content }),
    );
    expect(() =>
      receiveOutboxOutcome(attempt, {
        status: "conflict",
        reason: "deleted",
        submissionId: "saved",
        current: { ...deleted, revision: 3 },
      }),
    ).toThrow(expect.objectContaining({ code: "cursor-reset" }));
    const blocked = receiveOutboxOutcome(attempt, {
      status: "conflict",
      reason: "deleted",
      submissionId: "saved",
      current: deleted,
    });
    expect(prepareOutboxAttempt(retryBlockedOutbox(blocked, deleted, "re-add")).attempt).toEqual({
      ...key,
      op: "put",
      submissionId: "re-add",
      baseRevision: 5,
      content,
    });
  });
});
