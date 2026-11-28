import type { Change, Submission } from "@edo/contract";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createOutboxRecord,
  type OutboxRecord,
  prepareOutboxAttempt,
  queueOutboxEdit,
  receiveOutboxOutcome,
} from "../src/outbox.ts";
import { decodeStoredOutbox } from "../src/stored-outbox.ts";

const key = { kind: "meal", id: "meal-1" };
const base = {
  ...key,
  state: "live",
  revision: 4,
  content: { name: "Breakfast" },
} satisfies Change;
const edit = {
  op: "put",
  submissionId: "submission-1",
  content: { items: [{ calories: 0, protein: null }], futureField: { version: 5 } },
} as const;
const attempt = { ...key, ...edit, baseRevision: base.revision } satisfies Submission;
const later = { op: "delete", submissionId: "submission-2" } as const;
const current = { ...base, revision: 6, content: { name: "Remote breakfast" } } satisfies Change;
const conflict = {
  status: "conflict",
  submissionId: attempt.submissionId,
  reason: "stale",
  current,
} as const;
const clean = createOutboxRecord(key, base);
const queued = queueOutboxEdit(clean, edit);
const active = queueOutboxEdit(prepareOutboxAttempt(queued), later);
const blocked = receiveOutboxOutcome(active, conflict);

function saved(value: OutboxRecord): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("stored outbox decoder", () => {
  it("restores idle, queued, active and blocked states with exact record and submission types", () => {
    for (const record of [clean, queued, active, blocked]) {
      const decoded = decodeStoredOutbox(saved(record), key, record.attempt?.submissionId ?? null);
      expect(decoded).toStrictEqual(record);
      expectTypeOf(decoded).toEqualTypeOf<OutboxRecord>();
    }
  });

  it("restores a known base revision before its pulled snapshot and preserved blocked evidence", () => {
    const acknowledged = receiveOutboxOutcome(active, {
      status: "accepted",
      submissionId: attempt.submissionId,
      revision: 7,
    });
    expect(decodeStoredOutbox(saved(acknowledged), key, null)).toMatchObject({
      baseRevision: 7,
      base: null,
      pending: later,
    });
    const rejected = receiveOutboxOutcome(active, {
      status: "rejected",
      submissionId: attempt.submissionId,
      code: "invalid-content",
      message: "Use a food name",
    });
    expect(decodeStoredOutbox(saved(rejected), key, null)).toStrictEqual(rejected);
    const unavailableCurrent = { ...key, state: "unavailable", revision: 6 } as const;
    const compacted = receiveOutboxOutcome(active, { ...conflict, current: unavailableCurrent });
    expect(decodeStoredOutbox(saved(compacted), key, null)).toStrictEqual(compacted);
  });

  it("rejects any row, base, attempt, or blocked receipt with inconsistent identity or revision", () => {
    const goodBlocked = { submission: attempt, result: conflict };
    const candidates: readonly { readonly state: unknown; readonly attemptId: string | null }[] = [
      { state: { ...active, key: { ...key, id: "elsewhere" } }, attemptId: attempt.submissionId },
      {
        state: { ...active, attempt: { ...attempt, id: "elsewhere" } },
        attemptId: attempt.submissionId,
      },
      {
        state: { ...active, attempt: { ...attempt, kind: "custom-food" } },
        attemptId: attempt.submissionId,
      },
      {
        state: { ...active, attempt: { ...attempt, baseRevision: 3 } },
        attemptId: attempt.submissionId,
      },
      { state: { ...active, base: { ...base, id: "elsewhere" } }, attemptId: attempt.submissionId },
      { state: { ...active, base: { ...base, revision: 3 } }, attemptId: attempt.submissionId },
      { state: active, attemptId: "submission-from-another-row" },
      { state: active, attemptId: null },
      { state: queued, attemptId: attempt.submissionId },
      {
        state: {
          ...blocked,
          blocked: { ...goodBlocked, submission: { ...attempt, baseRevision: null } },
        },
        attemptId: null,
      },
      {
        state: {
          ...blocked,
          blocked: { ...goodBlocked, submission: { ...attempt, id: "elsewhere" } },
        },
        attemptId: null,
      },
      {
        state: {
          ...blocked,
          blocked: { ...goodBlocked, result: { ...conflict, submissionId: "elsewhere" } },
        },
        attemptId: null,
      },
      {
        state: {
          ...blocked,
          blocked: {
            ...goodBlocked,
            result: { ...conflict, current: { ...current, id: "elsewhere" } },
          },
        },
        attemptId: null,
      },
    ];
    for (const { state, attemptId } of candidates) {
      expect(() => decodeStoredOutbox(state, key, attemptId)).toThrow(/invalid stored outbox/i);
    }
  });

  it("rejects impossible states, duplicate IDs, and incomplete or unknown envelope fields", () => {
    const goodBlocked = { submission: attempt, result: conflict };
    const { blocked: absence, ...missingField } = clean;
    expect(absence).toBeNull();
    for (const [state, attemptId] of [
      [{ ...active, blocked: goodBlocked }, attempt.submissionId],
      [
        { ...active, pending: { ...later, submissionId: attempt.submissionId } },
        attempt.submissionId,
      ],
      [{ ...blocked, pending: { ...later, submissionId: attempt.submissionId } }, null],
      [
        {
          ...blocked,
          blocked: {
            ...goodBlocked,
            result: { status: "accepted", submissionId: attempt.submissionId, revision: 6 },
          },
        },
        null,
      ],
      [
        {
          ...blocked,
          blocked: {
            ...goodBlocked,
            result: {
              status: "retryable",
              submissionId: attempt.submissionId,
              reason: "temporarily-unavailable",
            },
          },
        },
        null,
      ],
      [
        { ...blocked, blocked: { ...goodBlocked, result: { ...conflict, reason: "deleted" } } },
        null,
      ],
      [{ ...clean, obsolete: true }, null],
      [{ ...clean, key: { ...key, account: "elsewhere" } }, null],
      [{ ...active, attempt: { ...attempt, transportEpoch: "earlier" } }, attempt.submissionId],
      [{ ...queued, pending: { ...edit, id: "different-target" } }, null],
      [{ ...queued, pending: { ...later, content: edit.content } }, null],
      [{ ...blocked, blocked: { ...goodBlocked, extra: false } }, null],
      [{ ...blocked, blocked: { ...goodBlocked, result: { ...conflict, extra: false } } }, null],
      [missingField, null],
      [{ ...clean, baseRevision: 0 }, null],
      [{ ...clean, baseRevision: Number.MAX_SAFE_INTEGER + 1 }, null],
    ] as const) {
      expect(() => decodeStoredOutbox(state, key, attemptId)).toThrow(/invalid stored outbox/i);
    }
  });

  it("rejects non-JSON values in all stored copies without calling getters", () => {
    const symbolField = { ...clean, [Symbol("hidden")]: true };
    const withGetter = {
      ...clean,
      get pending() {
        throw new Error("Unexpected getter call");
      },
    };
    const hiddenPendingId = Object.defineProperty({ op: "delete" }, "submissionId", {
      value: "hidden",
    });
    const cyclic: { next?: unknown } = {};
    cyclic.next = cyclic;
    for (const state of [
      { ...queued, pending: { ...edit, content: { energy: Number.NaN } } },
      { ...queued, pending: { ...edit, content: { raw: 42n } } },
      { ...queued, pending: { ...edit, content: { missing: undefined } } },
      { ...queued, pending: { ...edit, content: { when: new Date(0) } } },
      { ...queued, pending: { ...edit, content: { groups: Array(1) } } },
      { ...queued, pending: { ...edit, content: cyclic } },
      { ...clean, base: { ...base, content: { energy: Number.POSITIVE_INFINITY } } },
      {
        ...blocked,
        blocked: {
          submission: attempt,
          result: { ...conflict, current: { ...current, content: { unknown: Symbol("energy") } } },
        },
      },
      { ...queued, pending: hiddenPendingId },
      symbolField,
      withGetter,
      Object.create(clean),
    ]) {
      expect(() => decodeStoredOutbox(state, key, null)).toThrow(/invalid stored outbox/i);
    }
    expect(() =>
      decodeStoredOutbox(
        { ...active, attempt: { ...attempt, content: { energy: NaN } } },
        key,
        attempt.submissionId,
      ),
    ).toThrow(/invalid stored outbox/i);
  });
});
