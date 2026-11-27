import {
  type AuthenticatedHistory,
  acceptHello,
  decodeChange,
  decodeHelloRequest,
  decodeHelloResponse,
  decodeNegotiationRefused,
  decodePullRequest,
  decodePullResponse,
  decodePushRequest,
  decodePushResponse,
  decodeSyncError,
  favoriteRecordId,
  type HelloRequest,
  isKnownRecordKind,
  maxSyncPage,
  maxSyncSubmissions,
  type NegotiatedSync,
  negotiateHello,
  recordKinds,
  type SyncRelease,
  syncCandidate,
} from "@edo/contract";
import { describe, expect, test } from "vitest";

const history: AuthenticatedHistory = {
  accountBinding: "synthetic-account-1",
  lineage: "history-current",
  revision: 12,
  restoredFrom: { lineage: "history-backup", revision: 5 },
};
const hello: HelloRequest = { releases: [syncCandidate.release], features: ["write-records"] };
const scope = { release: syncCandidate.release, lineage: history.lineage };
const meal = {
  op: "put",
  submissionId: "edit-1",
  kind: "meal",
  id: "meal-1",
  baseRevision: 4,
  content: {
    localDay: "2026-11-27",
    items: [
      {
        id: "item-1",
        portion: { amount: 125, unit: "ml" },
        nutrients: { kcal: 0, proteinG: null },
        food: { id: { provider: "open-food-facts", sourceId: "00001234" }, release: "r1" },
      },
    ],
  },
};
const deletion = {
  op: "delete",
  submissionId: "edit-2",
  kind: "recipe",
  id: "recipe-1",
  baseRevision: 6,
};

function pair(
  request = hello,
  serverReleases: readonly SyncRelease[] = [syncCandidate],
  clientReleases: readonly SyncRelease[] = serverReleases,
) {
  const negotiation = negotiateHello(request, history, serverReleases);
  if (negotiation.status !== "ready") throw new Error("Fixture has no compatible release");
  return {
    ...negotiation,
    client: acceptHello(request, negotiation.response, history, clientReleases),
  };
}

describe("local candidate compatibility", () => {
  const newerRelease = {
    release: "0.2",
    features: ["write-records", "future-capability"],
    writableKinds: [...recordKinds, "future-kind"],
  } satisfies SyncRelease;

  test("old and new peers agree on a common release and negotiated features", () => {
    const newOffer = { releases: ["0.2", "0.1"], features: ["write-records", "future-capability"] };
    for (const pairing of [
      pair(hello, [newerRelease, syncCandidate], [syncCandidate]),
      pair(newOffer, [syncCandidate], [newerRelease, syncCandidate]),
    ]) {
      expect(pairing.response).toEqual({ release: "0.1", features: ["write-records"], ...history });
      expect(
        decodePushRequest({ ...scope, submissions: [meal] }, pairing.session).submissions,
      ).toEqual([meal]);
    }
    const newerPair = pair(newOffer, [newerRelease, syncCandidate]);
    expect(newerPair.response.release).toBe("0.2");
    expect(newerPair.response.features).toEqual(["write-records", "future-capability"]);
    const future = { ...meal, kind: "future-kind" };
    expect(
      decodePushRequest({ ...scope, release: "0.2", submissions: [future] }, newerPair.session)
        .submissions,
    ).toEqual([future]);
    expect(() => decodePushRequest({ ...scope, submissions: [future] }, pair().session)).toThrow(
      expect.objectContaining({ code: "invalid-request" }),
    );
  });

  test("a disjoint release or absent write capability cannot send writes", () => {
    const refusal = negotiateHello({ releases: ["9.0"], features: hello.features }, history);
    expect(decodeNegotiationRefused(refusal)).toEqual({
      status: "update-required",
      supportedReleases: ["0.1"],
    });
    expect(() =>
      decodePushRequest({ ...scope, submissions: [meal] }, {} as NegotiatedSync),
    ).toThrow(expect.objectContaining({ code: "update-required" }));
    const { session, client } = pair({ ...hello, features: [] });
    const forged = { ...session, features: ["write-records"] };
    expect(() => decodePushRequest({ ...scope, submissions: [meal] }, forged)).toThrow(
      expect.objectContaining({ code: "update-required" }),
    );
    expect(session.features).toEqual([]);
    expect(() => decodePushRequest({ ...scope, submissions: [meal] }, client)).toThrow(
      expect.objectContaining({ code: "write-disabled" }),
    );
    expect(decodePullRequest({ ...scope, cursor: 0 }, client)).toEqual({ ...scope, cursor: 0 });
  });

  test("an older peer preserves unknown JSON fields and opaque revisioned future records", () => {
    const { client } = pair();
    const request = decodePullRequest({ ...scope, cursor: 0 }, client);
    const expandedContent = JSON.parse(
      `{"id":"item-1","future":{"newArray":[null,0,{"__proto__":{"flag":"kept"}}]},"nutrition":{"fatG":null}}`,
    );
    const changes = [
      { state: "live", revision: 2, kind: "meal", id: "meal-1", content: expandedContent },
      {
        state: "live",
        revision: 4,
        kind: "future-kind",
        id: "opaque-1",
        content: { version: 2, extra: "Ä" },
      },
      { state: "unavailable", revision: 7, kind: "recipe", id: "recipe-1" },
    ];
    const incoming = { ...scope, cursor: 7, hasMore: false, changes };
    const page = decodePullResponse(incoming, request, client);
    expect(page.changes).toEqual(changes);
    expect(isKnownRecordKind(page.changes[1]?.kind ?? "")).toBe(false);
    expect(isKnownRecordKind(page.changes[0]?.kind ?? "")).toBe(true);
    const oldView = page.changes[0];
    if (oldView?.state !== "live") throw new Error("Invalid fixture");
    const update = {
      ...meal,
      baseRevision: oldView.revision,
      content: { ...oldView.content, id: "item-2" },
    };
    expect(decodePushRequest({ ...scope, submissions: [update] }, client).submissions).toEqual([
      update,
    ]);
    expect(Reflect.get(Object.prototype, "flag")).toBeUndefined();
  });
});

test("hello carries authenticated scope and detects responses from another binding or lineage", () => {
  const { response, client } = pair();
  expect(decodeHelloRequest(hello)).toEqual(hello);
  expect(decodeHelloResponse(response)).toEqual(response);
  expect(client.accountBinding).toBe(history.accountBinding);
  expect(() => decodeHelloRequest({ ...hello, accountBinding: "from-request" })).toThrow(
    expect.objectContaining({ code: "invalid-request" }),
  );
  expect(() => acceptHello(hello, { ...response, accountBinding: "other" }, history)).toThrow(
    expect.objectContaining({ code: "account-changed" }),
  );
  expect(() => acceptHello(hello, { ...response, lineage: "new" }, history)).toThrow(
    expect.objectContaining({ code: "lineage-changed" }),
  );
  expect(() =>
    acceptHello(hello, { ...response, revision: history.revision - 1 }, history),
  ).toThrow(expect.objectContaining({ code: "cursor-reset" }));
  expect(() => acceptHello(hello, { ...response, features: ["unexpected"] }, history)).toThrow(
    expect.objectContaining({ code: "invalid-request" }),
  );
  expect(() =>
    decodeHelloResponse({ ...response, restoredFrom: { lineage: scope.lineage, revision: 5 } }),
  ).toThrow(expect.objectContaining({ code: "invalid-request" }));
  expect(() => decodePullRequest({ ...scope, cursor: 0, lineage: "previous" }, client)).toThrow(
    expect.objectContaining({ code: "lineage-changed" }),
  );
  expect(
    decodeSyncError({ error: { code: "cursor-reset", message: "Account history changed" } }),
  ).toEqual({ error: { code: "cursor-reset", message: "Account history changed" } });
});

test("push decodes all outcomes with one result per stable submission ID", () => {
  const { client, session } = pair();
  const submissions = [
    meal,
    deletion,
    { ...meal, id: "meal-2", submissionId: "edit-3" },
    { ...meal, id: "meal-3", submissionId: "edit-4", baseRevision: null },
    { ...meal, id: "meal-4", submissionId: "edit-5" },
    { ...meal, id: "meal-5", submissionId: "edit-6" },
  ];
  const request = decodePushRequest({ ...scope, submissions }, session);
  const results = [
    { status: "accepted", submissionId: "edit-1", revision: 13 },
    {
      status: "conflict",
      submissionId: "edit-2",
      reason: "deleted",
      current: { state: "deleted", kind: "recipe", id: "recipe-1", revision: 8 },
    },
    { status: "conflict", submissionId: "edit-3", reason: "stale", current: null },
    {
      status: "conflict",
      submissionId: "edit-4",
      reason: "exists",
      current: { state: "live", kind: "meal", id: "meal-3", revision: 9, content: { items: [] } },
    },
    {
      status: "rejected",
      submissionId: "edit-5",
      code: "submission-reused",
      message: "A different request used this ID",
    },
    { status: "retryable", submissionId: "edit-6", reason: "temporarily-unavailable" },
  ];
  expect(decodePushResponse({ ...scope, results }, request, client)).toEqual({ ...scope, results });
  expect(() =>
    decodePushResponse({ ...scope, results: [...results].reverse() }, request, client),
  ).toThrow(expect.objectContaining({ code: "invalid-request" }));
  expect(() =>
    decodePushResponse({ ...scope, results: results.slice(1) }, request, client),
  ).toThrow(expect.objectContaining({ code: "invalid-request" }));
  const unrelated = {
    ...results[1],
    current: { state: "deleted", kind: "recipe", id: "other", revision: 9 },
  };
  expect(() =>
    decodePushResponse(
      { ...scope, results: [{ ...results[0], revision: 1 }, ...results.slice(1)] },
      {
        ...request,
        submissions: [{ ...meal, op: "put", baseRevision: 3 }, ...request.submissions.slice(1)],
      },
      client,
    ),
  ).toThrow(expect.objectContaining({ code: "invalid-request" }));
  expect(() =>
    decodePushResponse(
      { ...scope, results: [results[0], unrelated, ...results.slice(2)] },
      request,
      client,
    ),
  ).toThrow(expect.objectContaining({ code: "invalid-request" }));
});

test("unsafe push envelopes, IDs and non-JSON content are rejected", () => {
  const { session } = pair();
  const cyclic = { content: {} };
  cyclic.content = cyclic;
  const tooMany = Array.from({ length: maxSyncSubmissions + 1 }, (_, index) => ({
    ...meal,
    submissionId: String(index),
  }));
  for (const submissions of [
    [],
    [meal, { ...meal, id: "other" }],
    tooMany,
    [undefined],
    Array(1),
    [meal, { ...deletion, content: {} }],
    [{ ...meal, baseRevision: 0 }],
    [{ ...meal, baseRevision: 3.5 }],
    [{ ...meal, id: "broken\ud800" }],
    [{ ...meal, id: "broken\u0000" }],
    [{ ...meal, content: [] }],
    [{ ...meal, content: { bad: NaN } }],
    [{ ...meal, content: { bad: Infinity } }],
    [{ ...meal, content: { bad: 1n } }],
    [{ ...meal, content: { bad: undefined } }],
    [{ ...meal, content: { bad: new Date() } }],
    [{ ...meal, content: { bad: Array(3) } }],
    [{ ...meal, content: cyclic }],
  ]) {
    expect(() => decodePushRequest({ ...scope, submissions }, session)).toThrow(
      expect.objectContaining({ code: "invalid-request" }),
    );
  }
  expect(() =>
    decodePushRequest({ ...scope, accountBinding: "other", submissions: [meal] }, session),
  ).toThrow(expect.objectContaining({ code: "invalid-request" }));
  const id = favoriteRecordId("open-food-facts", "00001234:ä");
  const favorite = { ...meal, kind: "favorite", id, content: {} };
  expect(decodePushRequest({ ...scope, submissions: [favorite] }, session).submissions).toEqual([
    favorite,
  ]);
  expect(() => decodeChange({ ...favorite, op: undefined })).toThrow();
  expect(() =>
    decodeChange({
      state: "deleted",
      kind: "favorite",
      id: '[ "open-food-facts", "00001234:ä" ]',
      revision: 7,
    }),
  ).toThrow(expect.objectContaining({ code: "invalid-request" }));
});

test("pull pages validate cursors, revisions, progression and limits", () => {
  const { client } = pair();
  const request = decodePullRequest({ ...scope, cursor: 4, limit: 2 }, client);
  const current = { state: "deleted", kind: "meal", id: "meal-1", revision: 5 };
  expect(
    decodePullResponse({ ...scope, cursor: 5, hasMore: true, changes: [current] }, request, client),
  ).toEqual({ ...scope, cursor: 5, hasMore: true, changes: [current] });
  expect(
    decodePullResponse({ ...scope, cursor: 4, hasMore: false, changes: [] }, request, client)
      .cursor,
  ).toBe(4);
  expect(() =>
    decodePullRequest({ ...scope, cursor: Number.MAX_SAFE_INTEGER + 1 }, client),
  ).toThrow(expect.objectContaining({ code: "invalid-request" }));
  expect(() => decodePullRequest({ ...scope, cursor: 0, limit: maxSyncPage + 1 }, client)).toThrow(
    expect.objectContaining({ code: "invalid-request" }),
  );
  for (const page of [
    { cursor: 7, hasMore: true, changes: [current] },
    { cursor: 7, hasMore: true, changes: [] },
    { cursor: 4, hasMore: true, changes: [] },
    { cursor: 3, hasMore: false, changes: [] },
    { cursor: 7, hasMore: false, changes: [{ ...current, revision: 9 }] },
    { cursor: 7, hasMore: false, changes: [{ ...current, revision: 4 }] },
    { cursor: 7, hasMore: false, changes: [{ ...current, revision: 7 }, current] },
    { cursor: 7, hasMore: false, changes: [current, current] },
    {
      cursor: 7,
      hasMore: false,
      changes: [current, { ...current, revision: 6 }, { ...current, revision: 7 }],
    },
  ]) {
    expect(() => decodePullResponse({ ...scope, ...page }, request, client)).toThrow(
      expect.objectContaining({ code: "invalid-request" }),
    );
  }
});
