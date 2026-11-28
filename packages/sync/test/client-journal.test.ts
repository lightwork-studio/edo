import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Change, JsonValue, SubmissionResult } from "@edo/contract";
import { expect, test, vi } from "vitest";
import { applyRecordContent } from "../../../apps/sync-node/src/record-projection.ts";
import { createHealthServer } from "../../../apps/sync-node/src/server.ts";
import { openSyncStore } from "../../../apps/sync-node/src/sync-store.ts";
import { createSyncClient, installSyncJournal, openSyncJournal } from "../src/index.ts";

const key = { kind: "weigh-in", id: "weight-1" };
function edit(submissionId: string, kg: number) {
  return {
    submissionId,
    op: "put" as const,
    content: {
      id: key.id,
      localDay: "2026-11-27",
      occurredAt: Date.parse("2026-11-27T12:00:00Z"),
      kg,
    },
  };
}

function diary(file: string, fresh = true) {
  const sqlite = new DatabaseSync(file);
  const connection = {
    exec: (sql: string) => sqlite.exec(sql),
    run: (sql: string, ...parameters: (string | number | null)[]) => {
      sqlite.prepare(sql).run(...parameters);
    },
    get: (sql: string, ...parameters: (string | number | null)[]) =>
      sqlite.prepare(sql).get(...parameters),
    all: (sql: string, ...parameters: (string | number | null)[]) =>
      sqlite.prepare(sql).all(...parameters),
  };
  if (fresh) {
    sqlite.exec("CREATE TABLE diary_fixture (id TEXT PRIMARY KEY, kg REAL NOT NULL) STRICT");
    installSyncJournal(connection);
  }
  const set = (weight: number): undefined => {
    connection.run("INSERT OR REPLACE INTO diary_fixture VALUES (?, ?)", key.id, weight);
  };
  return {
    sqlite,
    connection,
    journal: openSyncJournal(connection),
    set,
    get: () => connection.get("SELECT kg FROM diary_fixture WHERE id = ?", key.id)?.kg ?? null,
    receive(change: Change): undefined {
      if (
        change.state !== "live" ||
        change.kind !== key.kind ||
        typeof change.content.kg !== "number"
      )
        throw new Error("Wrong fixture type");
      set(change.content.kg);
    },
    [Symbol.dispose]: () => sqlite[Symbol.dispose](),
  };
}

test("local edits roll back with failed queue writes", async () => {
  using local = diary(":memory:");
  const session = await candidateSession();
  local.journal.bind(session);
  local.sqlite.exec(
    "CREATE TRIGGER stop_queue BEFORE INSERT ON edo_sync_outbox BEGIN SELECT RAISE(ABORT,'insert failed'); END",
  );
  expect(() => local.journal.commitLocal(key, edit("first", 74), () => local.set(74))).toThrow(
    "insert failed",
  );
  expect(local.get()).toBeNull();
  expect(local.journal.queued()).toEqual([]);
  local.sqlite.exec("DROP TRIGGER stop_queue");
  local.journal.commitLocal(key, edit("first", 74), () => local.set(74));
  expect(local.get()).toBe(74);
  expect(local.journal.prepare(session)).toMatchObject([
    { submissionId: "first", baseRevision: null },
  ]);
  expect(() =>
    local.journal.commitLocal({ ...key, id: "different" }, edit("first", 75), () => local.set(75)),
  ).toThrow(/reuse/);
  expect(local.get()).toBe(74);
});

test("two file-backed devices survive a lost response and preserve stale edits and the separate pull cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "edo-client-journal-"));
  const firstPath = join(root, "local-a.sqlite");
  try {
    using store = openSyncStore(join(root, "account.sqlite"), { applyContent: applyRecordContent });
    store.createAccount("account", "fixture");
    await using server = createHealthServer({
      sync: {
        store,
        authorize(request) {
          const auth = request.headers.authorization;
          if (auth === "Bearer synthetic-a" || auth === "Bearer synthetic-b") {
            return {
              accountBinding: "account",
              sessionKey: auth.endsWith("a") ? "session-a" : "session-b",
            };
          }
          return null;
        },
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback address");
    const origin = `http://127.0.0.1:${address.port}`;
    const clientA = createSyncClient({
      origin,
      authorization: () => "Bearer synthetic-a",
      allowLoopbackHttp: true,
    });
    const clientB = createSyncClient({
      origin,
      authorization: () => "Bearer synthetic-b",
      allowLoopbackHttp: true,
    });
    let lost: readonly unknown[] = [];
    {
      using a = diary(firstPath);
      const session = await clientA.connect();
      a.journal.bind(session);
      a.journal.commitLocal(key, edit("a-1", 74), () => a.set(74));
      const attempt = a.journal.prepare(session);
      lost = attempt;
      await clientA.push(session, attempt);
      a.journal.commitLocal(key, edit("a-2", 75), () => a.set(75));
      expect(a.journal.history()?.cursor).toBe(0);
      expect(a.get()).toBe(75);
    }
    using a = diary(firstPath, false);
    using b = diary(join(root, "local-b.sqlite"));
    const sessionA = await clientA.connect(a.journal.history() ?? undefined);
    const sessionB = await clientB.connect();
    a.journal.bind(sessionA);
    b.journal.bind(sessionB);
    const resumed = a.journal.prepare(sessionA);
    expect(resumed).toEqual(lost);
    const ack = await clientA.push(sessionA, resumed);
    expect(() => a.journal.applyResults(sessionA, { ...ack }, a.receive)).toThrow(
      expect.objectContaining({ code: "update-required" }),
    );
    a.journal.applyResults(sessionA, ack, a.receive);
    a.journal.applyResults(sessionA, ack, a.receive);
    expect(a.journal.blockedReview(key)).toBeNull();
    expect(a.journal.history()).toMatchObject({ revision: 1, cursor: 0 });
    expect(a.journal.queued()).toMatchObject([
      { pending: { submissionId: "a-2" }, baseRevision: 1 },
    ]);

    b.journal.applyPage(sessionB, 0, await clientB.pull(sessionB, 0), b.receive);
    expect(b.get()).toBe(74);
    b.journal.commitLocal(key, edit("b-1", 81), () => b.set(81));
    const changed = await clientB.push(sessionB, b.journal.prepare(sessionB));
    b.journal.applyResults(sessionB, changed, b.receive);
    expect(b.journal.history()).toMatchObject({ revision: 2, cursor: 1 });
    const nextA = a.journal.prepare(sessionA);
    expect(nextA).toMatchObject([{ submissionId: "a-2", baseRevision: 1 }]);
    const conflict = await clientA.push(sessionA, nextA);
    a.journal.applyResults(sessionA, conflict, a.receive);
    expect(a.journal.queued()).toMatchObject([
      { blocked: { result: { status: "conflict", current: { revision: 2 } } } },
    ]);
    const beforePull = a.journal.blockedReview(key);
    if (!beforePull) throw new Error("Expected a blocked review");
    expect(beforePull).toMatchObject({
      baseRevision: 1,
      original: null,
      device: { submissionId: "a-2", content: { kg: 75 } },
      blocked: {
        submission: { submissionId: "a-2" },
        result: { status: "conflict", current: { revision: 2, content: { kg: 81 } } },
      },
      pulled: null,
    });
    a.journal.applyPage(sessionA, 0, await clientA.pull(sessionA, 0), a.receive);
    expect(a.get()).toBe(75);
    expect(a.journal.serverCopy(key)).toMatchObject({ revision: 2, content: { kg: 81 } });
    expect(() => a.journal.retryReviewed(beforePull, "a-3")).toThrow(/changed during review/);
    const beforeEdit = a.journal.blockedReview(key);
    if (!beforeEdit) throw new Error("Expected a pulled review");
    a.journal.commitLocal(key, edit("new-draft", 75), () => a.set(75));
    expect(() => a.journal.retryReviewed(beforeEdit, "a-3")).toThrow(/changed during review/);
    a.journal.commitLocal(key, edit("latest-draft", 75), () => a.set(75));
    const current = a.journal.blockedReview(key);
    if (!current) throw new Error("Expected the current review");
    expect(current).toMatchObject({
      device: { submissionId: "latest-draft", content: { kg: 75 } },
      blocked: { submission: { submissionId: "a-2" } },
      pulled: { revision: 2, content: { kg: 81 } },
    });
    expect(() => a.journal.commitLocal(key, edit("new-draft", 78), () => a.set(78))).toThrow(
      /cannot reuse/,
    );
    expect(() => a.journal.retryReviewed({ ...current }, "a-3")).toThrow(/Open the blocked edit/);
    expect(() => openSyncJournal(a.connection).retryReviewed(current, "a-3")).toThrow(
      /Open the blocked edit/,
    );
    expect(() => a.journal.retryReviewed(current, "x".repeat(1025))).toThrow(
      expect.objectContaining({ code: "invalid-request" }),
    );
    a.journal.retryReviewed(current, "a-3");
    const resolved = await clientA.push(sessionA, a.journal.prepare(sessionA));
    a.journal.applyResults(sessionA, resolved, a.receive);
    expect(a.journal.blockedReview(key)).toBeNull();
    expect(a.journal.history()).toMatchObject({ revision: 3, cursor: 2 });
    expect(a.journal.queued()).toEqual([]);

    const page = await clientB.pull(sessionB, 1);
    expect(() => b.journal.applyPage(sessionB, 0, page, b.receive)).toThrow(
      expect.objectContaining({ code: "cursor-reset" }),
    );
    expect(() =>
      b.journal.applyPage(sessionB, 1, page, (record) => {
        b.receive(record);
        throw new Error("rollback device write");
      }),
    ).toThrow("rollback device write");
    expect(b.get()).toBe(81);
    expect(b.journal.history()?.cursor).toBe(1);
    b.journal.applyPage(sessionB, 1, page, b.receive);
    expect(b.journal.history()).toMatchObject({ revision: 3, cursor: 3 });
    expect(b.get()).toBe(75);
    expect(b.sqlite.prepare("PRAGMA integrity_check").get()).toMatchObject({
      integrity_check: "ok",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a blocked review cannot combine its old device edit with a newer pull after a concurrent commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "edo-blocked-review-"));
  try {
    const path = join(root, "diary.sqlite");
    using client = diary(path);
    client.sqlite.exec("PRAGMA journal_mode = WAL");
    client.journal.bind(await candidateSession());
    using writer = new DatabaseSync(path);
    const original = { ...key, state: "live", revision: 1, content: edit("old", 74).content };
    const server = { ...original, revision: 2, content: edit("server", 81).content };
    const submitted = { ...key, baseRevision: 1, ...edit("blocked", 75) };
    const record = {
      key,
      baseRevision: 1,
      base: original,
      attempt: null,
      pending: null,
      blocked: {
        submission: submitted,
        result: {
          submissionId: submitted.submissionId,
          status: "conflict",
          reason: "stale",
          current: server,
        },
      },
    };
    const writeRemote = writer.prepare(
      "INSERT OR REPLACE INTO edo_sync_remote VALUES (?, ?, ?, ?)",
    );
    const writeDraft = writer.prepare(
      "INSERT OR REPLACE INTO edo_sync_outbox VALUES (?, ?, NULL, NULL, ?)",
    );
    writeDraft.run(key.kind, key.id, JSON.stringify(record));
    writeRemote.run(key.kind, key.id, server.revision, JSON.stringify(server));
    const newer = { ...server, revision: 3, content: edit("latest-server", 82).content };
    let injected = false;
    const review = openSyncJournal({
      ...client.connection,
      get(sql, ...parameters) {
        const row = client.connection.get(sql, ...parameters);
        if (!injected && sql.includes("FROM edo_sync_outbox")) {
          injected = true;
          writer.exec("BEGIN IMMEDIATE");
          writeDraft.run(
            key.kind,
            key.id,
            JSON.stringify({ ...record, pending: edit("latest-local", 77) }),
          );
          writeRemote.run(key.kind, key.id, newer.revision, JSON.stringify(newer));
          writer.exec("COMMIT");
        }
        return row;
      },
    });
    const originalReview = review.blockedReview(key);
    if (!originalReview) throw new Error("Expected the original review");
    expect(originalReview).toMatchObject({
      original: { revision: 1 },
      device: { submissionId: "blocked", content: { kg: 75 } },
      pulled: { revision: 2, content: { kg: 81 } },
    });
    expect(() => review.retryReviewed(originalReview, "review-retry")).toThrow(
      /changed during review/,
    );
    const currentReview = review.blockedReview(key);
    if (!currentReview) throw new Error("Expected the concurrent review");
    expect(currentReview).toMatchObject({
      original: { revision: 1 },
      device: { submissionId: "latest-local", content: { kg: 77 } },
      pulled: { revision: 3, content: { kg: 82 } },
    });
    writeDraft.run(
      key.kind,
      key.id,
      JSON.stringify({
        ...record,
        base: { ...original, content: { ...original.content, note: "verified again" } },
        pending: edit("latest-local", 77),
      }),
    );
    expect(() => review.retryReviewed(currentReview, "review-retry")).toThrow(
      /changed during review/,
    );
    const preMove = review.blockedReview(key);
    if (!preMove) throw new Error("Expected the review before the binding changed");
    const bindingServer = writer.prepare("UPDATE edo_sync_binding SET server = ?");
    bindingServer.run("https://other.test");
    expect(() => review.retryReviewed(preMove, "review-retry")).toThrow(/changed during review/);
    bindingServer.run("https://example.test");

    const refreshed = review.blockedReview(key);
    if (!refreshed) throw new Error("Expected the refreshed review");
    writer.exec("UPDATE edo_sync_binding SET observed_revision = 4, cursor = 4");
    review.retryReviewed(refreshed, "review-retry");
    expect(review.queued()).toMatchObject([
      { baseRevision: 3, pending: { submissionId: "review-retry", content: { kg: 77 } } },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function candidateSession(
  release = "0.1",
  features = ["write-records"],
  writableKinds = ["weigh-in"],
  origin = "https://example.test",
) {
  return createSyncClient({
    origin,
    releases: [{ release, features, writableKinds }],
    authorization: () => "Bearer synthetic",
    fetch: async () =>
      Response.json({
        accountBinding: "account",
        lineage: "fixture",
        revision: 0,
        restoredFrom: null,
        release,
        features,
      }),
  }).connect();
}

test("the journal consumes the authenticated push and pull snapshots", async () => {
  using local = diary(":memory:");
  const scope = { release: "0.1", accountBinding: "account", lineage: "fixture" };
  const change = { ...key, state: "live", revision: 1, content: edit("unused", 74).content };
  const client = createSyncClient({
    origin: "https://example.test",
    authorization: () => "Bearer synthetic",
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/hello")) {
        return Response.json({
          ...scope,
          revision: 0,
          restoredFrom: null,
          features: ["write-records"],
        });
      }
      if (url.endsWith("/push")) {
        return Response.json({
          ...scope,
          results: [
            { submissionId: "local", status: "retryable", reason: "temporarily-unavailable" },
          ],
        });
      }
      const futureChange = {
        ...change,
        content: { ...change.content, futureValue: "fixture-negative-zero" },
      };
      const page = JSON.stringify({ ...scope, cursor: 1, hasMore: false, changes: [futureChange] });
      return new Response(page.replace('"fixture-negative-zero"', "-0"));
    },
  });
  const session = await client.connect();
  local.journal.bind(session);
  local.journal.commitLocal(key, edit("local", 75), () => local.set(75));
  const attempt = local.journal.prepare(session);
  const receipt = await client.push(session, attempt);
  Object.defineProperty(receipt.results, Symbol.iterator, {
    *value() {
      yield { submissionId: "local", status: "accepted", revision: 99 };
    },
  });
  local.journal.applyResults(session, receipt, local.receive);
  expect.soft(local.journal.history()).toMatchObject({ revision: 0, cursor: 0 });
  expect.soft(local.journal.prepare(session)).toEqual(attempt);

  // A second reader with no pending edit must project the original disk value.
  using peer = diary(":memory:");
  peer.journal.bind(session);
  const page = await client.pull(session, 0);
  const changes = page.changes;
  Object.defineProperty(page, "changes", {
    enumerable: true,
    get() {
      Object.defineProperty(page, "changes", {
        value: [{ ...change, content: { ...change.content, kg: 98 } }],
      });
      return changes;
    },
  });
  peer.journal.applyPage(session, 0, page, (record) => {
    expect(record.state === "live" && Object.is(record.content.futureValue, -0)).toBe(true);
    peer.receive(record);
  });
  expect(peer.get()).toBe(74);
  expect(peer.journal.history()).toMatchObject({ revision: 1, cursor: 1 });
});

test("the journal refuses a response whose enumerable payload has changed", async () => {
  using local = diary(":memory:");
  const scope = { release: "0.1", accountBinding: "account", lineage: "fixture" };
  const client = createSyncClient({
    origin: "https://example.test",
    authorization: () => "Bearer synthetic",
    fetch: async (input) =>
      Response.json(
        String(input).endsWith("/hello")
          ? { ...scope, revision: 0, restoredFrom: null, features: ["write-records"] }
          : { ...scope, cursor: 0, hasMore: false, changes: [] },
      ),
  });
  const session = await client.connect();
  local.journal.bind(session);
  const page = await client.pull(session, 0);
  Object.defineProperty(page, "cursor", { value: 42 });
  expect(() => local.journal.applyPage(session, 0, page, local.receive)).toThrow(
    expect.objectContaining({ code: "invalid-request" }),
  );
  expect(local.journal.history()).toMatchObject({ revision: 0, cursor: 0 });
});

test("the journal runs response code outside writes and rolls back when the connection changes", async () => {
  using local = diary(":memory:");
  const scope = { release: "0.1", accountBinding: "account", lineage: "fixture" };
  const client = createSyncClient({
    origin: "https://example.test",
    authorization: () => "Bearer synthetic",
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/hello")) {
        return Response.json({
          ...scope,
          revision: 0,
          restoredFrom: null,
          features: ["write-records"],
        });
      }
      if (url.endsWith("/push")) {
        return Response.json({
          ...scope,
          results: [{ submissionId: "local", status: "accepted", revision: 1 }],
        });
      }
      const change = { ...key, state: "live", revision: 1, content: edit("unused", 74).content };
      return Response.json({ ...scope, cursor: 1, hasMore: false, changes: [change] });
    },
  });
  const session = await client.connect();
  local.journal.bind(session);
  local.journal.commitLocal(key, edit("local", 75), () => local.set(75));
  const attempt = local.journal.prepare(session);
  const transactionProbe = await client.push(session, attempt);
  Object.defineProperty(transactionProbe, "toJSON", {
    value: () => {
      local.sqlite.exec("COMMIT");
      return { ...transactionProbe };
    },
  });
  expect(() => local.journal.applyResults(session, transactionProbe, local.receive)).toThrow(
    "no transaction is active",
  );
  expect(local.journal.history()).toMatchObject({ revision: 0, cursor: 0 });
  expect(local.journal.prepare(session)).toEqual(attempt);

  const receipt = await client.push(session, attempt);
  let reconnected: ReturnType<typeof client.connect> | undefined;
  Object.defineProperty(receipt, "toJSON", {
    value: () => {
      reconnected = client.connect();
      return { ...receipt };
    },
  });
  try {
    expect
      .soft(() => local.journal.applyResults(session, receipt, local.receive))
      .toThrow(expect.objectContaining({ code: "update-required" }));
  } finally {
    await reconnected;
  }
  expect.soft(local.journal.history()).toMatchObject({ revision: 0, cursor: 0 });
  expect.soft(local.journal.queued()[0]?.attempt?.submissionId).toBe("local");

  const next = await client.connect();
  using peer = diary(":memory:");
  peer.journal.bind(next);
  const page = await client.pull(next, 0);
  try {
    expect(() =>
      peer.journal.applyPage(next, 0, page, (change) => {
        peer.receive(change);
        reconnected = client.connect();
      }),
    ).toThrow(expect.objectContaining({ code: "update-required" }));
  } finally {
    await reconnected;
  }
  expect(peer.get()).toBeNull();
  expect(peer.journal.serverCopy(key)).toBeNull();
  expect(peer.journal.history()).toMatchObject({ revision: 0, cursor: 0 });

  const nextSession = await client.connect();
  peer.journal.bind(nextSession);
  const nextPage = await client.pull(nextSession, 0);
  peer.sqlite.function("reconnect_fixture", () => {
    reconnected = client.connect();
    return null;
  });
  peer.sqlite.exec(`CREATE TRIGGER reconnect_on_cursor AFTER UPDATE OF cursor ON edo_sync_binding
    BEGIN SELECT reconnect_fixture(); END`);
  try {
    expect(() => peer.journal.applyPage(nextSession, 0, nextPage, peer.receive)).toThrow(
      expect.objectContaining({ code: "update-required" }),
    );
  } finally {
    await reconnected;
  }
  expect(peer.get()).toBeNull();
  expect(peer.journal.serverCopy(key)).toBeNull();
  expect(peer.journal.history()).toMatchObject({ revision: 0, cursor: 0 });
});

test("keeps authenticated meal projection history separate from the released server copy", async () => {
  using local = diary(":memory:");
  const key = { kind: "meal", id: "meal-projection" };
  const content = {
    id: key.id,
    localDay: "2026-11-27",
    occurredAt: Date.parse("2026-11-28T02:30:00Z"),
    items: [],
  };
  const server = { ...content, utcOffsetMinutes: -240 };
  const scope = { accountBinding: "account", lineage: "fixture", release: "0.1" };
  let accepted = { status: "accepted", submissionId: "meal-put", revision: 1 };
  const client = createSyncClient({
    origin: "https://example.test",
    authorization: () => "Bearer synthetic",
    fetch: async (url) => {
      if (String(url).endsWith("/hello")) {
        return Response.json({
          ...scope,
          features: ["write-records"],
          revision: 0,
          restoredFrom: null,
        });
      }
      if (String(url).endsWith("/push")) return Response.json({ ...scope, results: [accepted] });
      return Response.json({
        ...scope,
        cursor: 1,
        hasMore: false,
        changes: [{ ...key, state: "live", revision: 1, content: server }],
      });
    },
  });
  const session = await client.connect();
  const journal = local.journal;
  journal.bind(session);
  journal.commitLocal(key, { op: "put", submissionId: "meal-put", content }, () => undefined);
  const attempt = journal.prepare(session);
  const receipt = await client.push(session, attempt);
  local.sqlite.exec(`CREATE TRIGGER stop_evidence BEFORE INSERT ON edo_sync_meal_projections
    BEGIN SELECT RAISE(ABORT, 'projection unavailable'); END`);
  expect(() => journal.applyResults(session, receipt, () => undefined)).toThrow(
    /projection unavailable/,
  );
  expect(journal.mealProjection(key.id)).toBeNull();
  expect(journal.prepare(session)).toEqual(attempt);
  local.sqlite.exec("DROP TRIGGER stop_evidence");

  journal.applyResults(session, receipt, () => undefined);
  journal.applyResults(session, receipt, () => undefined);
  expect(journal.mealProjection(key.id)).toEqual({ revision: 1, origin: "accepted", content });
  expect(journal.serverCopy(key)).toBeNull();
  expect(journal.history()).toMatchObject({ cursor: 0, revision: 1 });

  const page = await client.pull(session, 0);
  journal.applyPage(session, 0, page, (change) => {
    if (change.state === "live") (change.content as Record<string, JsonValue>).utcOffsetMinutes = 0;
  });
  expect(journal.mealProjection(key.id)).toEqual({
    revision: 1,
    origin: "pulled",
    content: server,
  });
  expect(local.sqlite.prepare("SELECT content FROM edo_sync_meal_projections").get()).toEqual({
    content: null,
  });
  expect(journal.serverCopy(key)).toMatchObject({ content: server });

  journal.commitLocal(key, { op: "delete", submissionId: "meal-delete" }, () => undefined);
  expect(journal.mealProjection(key.id)).toBeNull();
  accepted = { status: "accepted", revision: 2, submissionId: "meal-delete" };
  journal.applyResults(
    session,
    await client.push(session, journal.prepare(session)),
    () => undefined,
  );
  expect(journal.mealProjection(key.id)).toEqual({
    revision: 2,
    origin: "accepted",
    content: null,
  });
  expect(journal.serverCopy(key)).toMatchObject({ revision: 1, content: server });
});

test("snapshots every authenticated receipt before calling a projection writer", async () => {
  using local = diary(":memory:");
  const scope = { accountBinding: "account", lineage: "fixture", release: "0.1" };
  const first = { kind: "meal", id: "first-meal" };
  const second = { kind: "meal", id: "second-meal" };
  const client = createSyncClient({
    origin: "https://example.test",
    authorization: () => "Bearer synthetic",
    fetch: async (url) => {
      if (String(url).endsWith("/hello")) {
        return Response.json({
          ...scope,
          features: ["write-records"],
          revision: 0,
          restoredFrom: null,
        });
      }
      if (String(url).endsWith("/pull")) {
        return Response.json({
          ...scope,
          cursor: 1,
          hasMore: false,
          changes: [{ ...first, state: "live", revision: 1, content: { id: first.id } }],
        });
      }
      return Response.json({
        ...scope,
        results: [
          { status: "accepted", submissionId: "first-put", revision: 1 },
          {
            status: "rejected",
            submissionId: "second-put",
            code: "invalid-content",
            message: "The second meal needs review",
          },
        ],
      });
    },
  });
  const session = await client.connect();
  const journal = local.journal;
  journal.bind(session);
  journal.commitLocal(
    first,
    { op: "put", submissionId: "first-put", content: { id: first.id } },
    () => undefined,
  );
  journal.commitLocal(
    second,
    { op: "put", submissionId: "second-put", content: { id: second.id } },
    () => undefined,
  );
  const attempts = journal.prepare(session);
  journal.applyPage(session, 0, await client.pull(session, 0), () => undefined);
  const receipts = await client.push(session, attempts);
  journal.applyResults(session, receipts, (remote) => {
    expect(remote.id).toBe(first.id);
    (receipts.results as SubmissionResult[])[1] = {
      status: "accepted",
      submissionId: "second-put",
      revision: 99,
    };
  });
  expect(journal.queued()).toMatchObject([
    { key: second, blocked: { result: { status: "rejected", submissionId: "second-put" } } },
  ]);
  expect(journal.mealProjection(first.id)).toMatchObject({ origin: "pulled", revision: 1 });
  expect(journal.mealProjection(second.id)).toBeNull();
  expect(journal.history()).toMatchObject({ revision: 1, cursor: 1 });
});

test("an unnegotiated session cannot bind a private diary", async () => {
  using local = diary(":memory:");
  const session = await candidateSession();
  expect(() => local.journal.bind({ ...session })).toThrow(
    expect.objectContaining({ code: "update-required" }),
  );
  expect(local.journal.history()).toBeNull();
  local.journal.bind(session);
  expect(local.journal.history()).toMatchObject({ accountBinding: "account" });
});

test("rebases the latest blocked draft only against a verified newer server copy", async () => {
  using local = diary(":memory:");
  const scope = { release: "0.1", accountBinding: "account", lineage: "fixture" };
  const base = { ...key, state: "live", revision: 1, content: edit("unused", 74).content };
  const server = { ...base, revision: 3, content: { ...base.content, serverNote: "preserved" } };
  let page = { ...scope, cursor: 1, hasMore: false, changes: [base] };
  const client = createSyncClient({
    origin: "https://example.test",
    authorization: () => "Bearer synthetic",
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/hello")) {
        return Response.json({
          ...scope,
          features: ["write-records"],
          revision: 0,
          restoredFrom: null,
        });
      }
      if (url.endsWith("/pull")) return Response.json(page);
      return Response.json({
        ...scope,
        results: [
          {
            status: "conflict",
            reason: "stale",
            submissionId: "first-edit",
            current: { ...key, state: "unavailable", revision: 2 },
          },
        ],
      });
    },
  });
  const session = await client.connect();
  local.journal.bind(session);
  local.journal.applyPage(session, 0, await client.pull(session, 0), (change) => {
    local.receive(change);
    if (change.state === "live") (change.content as Record<string, JsonValue>).kg = 77;
  });
  local.journal.commitLocal(key, edit("first-edit", 75), () => local.set(75));
  const attempt = local.journal.prepare(session);
  local.journal.commitLocal(key, edit("newer-edit", 76), () => local.set(76));
  const conflict = await client.push(session, attempt);
  local.journal.applyResults(session, conflict, local.receive);

  const resolve = vi.fn<Parameters<typeof local.journal.tryRebaseStalePut>[3]>(
    ({ base: original, draft, server: latest }) => {
      expect(original.kg).toBe(74);
      expect(draft.kg).toBe(76);
      expect(latest).toEqual(server.content);
      if (typeof draft.kg !== "number") throw new Error("Invalid fixture weight");
      const updated = latest as Record<string, JsonValue>;
      updated.kg = draft.kg;
      return updated;
    },
  );
  expect(local.journal.tryRebaseStalePut(session, key, "rebased", resolve, () => undefined)).toBe(
    false,
  );
  expect(resolve).not.toHaveBeenCalled();
  page = { ...page, cursor: 3, changes: [server] };
  local.journal.applyPage(session, 1, await client.pull(session, 1), local.receive);
  const before = local.journal.queued();
  expect(
    local.journal.tryRebaseStalePut(
      session,
      key,
      "rebased",
      () => null,
      () => undefined,
    ),
  ).toBe(false);
  expect(
    local.journal.tryRebaseStalePut(
      session,
      key,
      "rebased",
      () => ({ extra: "x".repeat(1_100_000) }),
      () => undefined,
    ),
  ).toBe(false);
  const tooManyValues = { extra: Array.from({ length: 50_001 }, () => 1) };
  expect(
    local.journal.tryRebaseStalePut(
      session,
      key,
      "rebased",
      () => tooManyValues,
      () => undefined,
    ),
  ).toBe(false);
  expect(local.journal.queued()).toEqual(before);
  expect(() =>
    local.journal.tryRebaseStalePut(
      session,
      key,
      "x".repeat(1025),
      () => tooManyValues,
      () => undefined,
    ),
  ).toThrow(expect.objectContaining({ code: "invalid-request" }));
  expect(() =>
    local.journal.tryRebaseStalePut(session, key, "rebased", resolve, () => {
      local.set(80);
      throw new Error("diary write interrupted");
    }),
  ).toThrow(/write interrupted/);
  expect(local.get()).toBe(76);
  expect(local.journal.queued()).toEqual(before);
  expect(
    local.journal.tryRebaseStalePut(session, key, "rebased", resolve, (content) => {
      expect(content).toMatchObject({ kg: 76, serverNote: "preserved" });
      expect(Object.isFrozen(content)).toBe(true);
      return local.set(76);
    }),
  ).toBe(true);
  expect(local.journal.queued()[0]?.base).toEqual(server);
  expect(local.journal.serverCopy(key)).toEqual(server);
  local.journal.applyResults(session, conflict, local.receive);
  expect(local.journal.prepare(session)).toMatchObject([
    {
      op: "put",
      baseRevision: 3,
      submissionId: "rebased",
      content: { kg: 76, serverNote: "preserved" },
    },
  ]);
  expect(local.journal.history()?.cursor).toBe(3);
});

test("accepts same-revision live evidence with reordered JSON members", async () => {
  using local = diary(":memory:");
  const scope = { release: "0.1", accountBinding: "account", lineage: "fixture" };
  const base = { ...key, state: "live", revision: 1, content: edit("unused", 74).content };
  const pulled = {
    ...base,
    revision: 2,
    content: { ...base.content, extra: { first: 1, second: 2 } },
  };
  const current = { ...pulled, content: { extra: { second: 2, first: 1 }, ...base.content } };
  let page = { ...scope, cursor: 1, hasMore: false, changes: [base] };
  const client = createSyncClient({
    origin: "https://example.test",
    authorization: () => "Bearer synthetic",
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/hello"))
        return Response.json({
          ...scope,
          features: ["write-records"],
          revision: 0,
          restoredFrom: null,
        });
      if (url.endsWith("/pull")) return Response.json(page);
      return Response.json({
        ...scope,
        results: [{ status: "conflict", reason: "stale", submissionId: "edit", current }],
      });
    },
  });
  const session = await client.connect();
  local.journal.bind(session);
  local.journal.applyPage(session, 0, await client.pull(session, 0), local.receive);
  local.journal.commitLocal(key, edit("edit", 75), () => local.set(75));
  const rejected = await client.push(session, local.journal.prepare(session));
  local.journal.applyResults(session, rejected, local.receive);
  page = { ...page, cursor: 2, changes: [pulled] };
  local.journal.applyPage(session, 1, await client.pull(session, 1), local.receive);

  expect(
    local.journal.tryRebaseStalePut(
      session,
      key,
      "replacement",
      ({ server }) => ({ ...server, kg: 75 }),
      () => local.set(75),
    ),
  ).toBe(true);
  expect(local.journal.queued()[0]?.base).toEqual(pulled);
  expect(local.journal.prepare(session)).toMatchObject([
    { baseRevision: 2, submissionId: "replacement", content: { kg: 75 } },
  ]);
});

test("rolls back a diary write when a callback returns a thenable", async () => {
  using local = diary(":memory:");
  local.journal.bind(await candidateSession());
  const write = (() => {
    local.set(75);
    return Promise.resolve();
  }) as unknown as () => undefined;
  expect(() => local.journal.commitLocal(key, edit("local", 75), write)).toThrow(/synchronously/);
  expect(local.get()).toBeNull();
  expect(local.journal.queued()).toEqual([]);
});

test("an unavailable pull marker does not become the base for an unseen record", async () => {
  using local = diary(":memory:");
  const scope = { release: "0.1", accountBinding: "account", lineage: "fixture" };
  const client = createSyncClient({
    origin: "https://example.test",
    authorization: () => "Bearer synthetic",
    fetch: async (input) =>
      Response.json(
        String(input).endsWith("/hello")
          ? { ...scope, features: ["write-records"], revision: 0, restoredFrom: null }
          : {
              ...scope,
              cursor: 1,
              hasMore: false,
              changes: [{ ...key, state: "unavailable", revision: 1 }],
            },
      ),
  });
  const session = await client.connect();
  local.journal.bind(session);
  local.journal.applyPage(session, 0, await client.pull(session, 0), () => {
    throw new Error("A marker is not a local record");
  });
  local.journal.commitLocal(key, edit("local", 75), () => local.set(75));
  expect(local.journal.prepare(session)).toMatchObject([
    { baseRevision: null, submissionId: "local" },
  ]);
});

test("read-only and incompatible releases leave a pending edit unpinned for reconnection", async () => {
  using local = diary(":memory:");
  const readOnly = await candidateSession("0.1", []);
  local.journal.bind(readOnly);
  local.journal.commitLocal(key, edit("first", 75), () => local.set(75));
  expect(() => local.journal.prepare(readOnly)).toThrow(
    expect.objectContaining({ code: "write-disabled" }),
  );

  const incompatible = await candidateSession("0.2", ["write-records"], ["meal"]);
  local.journal.bind(incompatible);
  expect(() => local.journal.prepare(incompatible)).toThrow(
    expect.objectContaining({ code: "update-required" }),
  );
  expect(local.get()).toBe(75);
  expect(local.journal.requiredRelease()).toBeNull();
  expect(local.journal.queued()).toMatchObject([{ pending: { submissionId: "first" } }]);

  const writable = await candidateSession("0.3");
  local.journal.bind(writable);
  expect(local.journal.prepare(writable)).toMatchObject([{ submissionId: "first" }]);
  expect(local.journal.requiredRelease()).toBe("0.3");
});

test("leaves oversized edits correctable, without blocking the next sendable record", async () => {
  using local = diary(":memory:");
  const session = await candidateSession();
  local.journal.bind(session);
  const oversized = edit("oversized", 75);
  local.journal.commitLocal(
    key,
    { ...oversized, content: { ...oversized.content, note: "x".repeat(800_000) } },
    () => local.set(75),
  );
  expect(() => local.journal.prepare(session, 1)).toThrow(/too large to sync/);
  expect(local.get()).toBe(75);
  expect(local.journal.requiredRelease()).toBeNull();
  expect(local.journal.queued()).toMatchObject([{ pending: { submissionId: "oversized" } }]);

  const second = { kind: key.kind, id: "weight-2" };
  const other = edit("other", 76);
  local.journal.commitLocal(
    second,
    { ...other, content: { ...other.content, id: second.id } },
    () => {},
  );
  expect(local.journal.prepare(session, 1)).toMatchObject([{ submissionId: "other" }]);
  local.journal.commitLocal(
    { kind: "meal", id: "unsupported" },
    { op: "put", submissionId: "unsupported", content: {} },
    () => {},
  );
  local.journal.commitLocal(key, edit("corrected", 74), () => local.set(74));
  expect(local.journal.prepare(session, 2)).toMatchObject([
    { submissionId: "other" },
    { submissionId: "corrected" },
  ]);
});

test("a late receipt atomically applies a newer remote copy already delivered during flight", async () => {
  using local = diary(":memory:");
  const scope = { release: "0.1", accountBinding: "account", lineage: "fixture" };
  const client = createSyncClient({
    origin: "https://example.test",
    authorization: () => "Bearer synthetic",
    fetch: async (input) => {
      if (String(input).endsWith("/hello")) {
        return Response.json({
          ...scope,
          features: ["write-records"],
          revision: 0,
          restoredFrom: null,
        });
      }
      if (String(input).endsWith("/pull")) {
        return Response.json({
          ...scope,
          cursor: 3,
          hasMore: false,
          changes: [{ state: "live", ...key, revision: 3, content: edit("ignored", 81).content }],
        });
      }
      return Response.json({
        ...scope,
        results: [{ status: "accepted", submissionId: "first", revision: 2 }],
      });
    },
  });
  const session = await client.connect();
  local.journal.bind(session);
  local.journal.commitLocal(key, edit("first", 75), () => local.set(75));
  const sent = local.journal.prepare(session);
  local.journal.applyPage(session, 0, await client.pull(session, 0), local.receive);
  expect(local.get()).toBe(75);
  expect(local.journal.history()?.cursor).toBe(3);
  const attempt = sent[0];
  if (attempt?.op !== "put") throw new Error("Missing fixture submission");
  const wrongReceipt = await client.push(session, [
    { ...attempt, content: { ...attempt.content, kg: 77 } },
  ]);
  expect(() => local.journal.applyResults(session, wrongReceipt, local.receive)).toThrow(
    /different submission/,
  );
  const changedReceipt = await client.push(session, sent);
  Object.assign(changedReceipt, { lineage: "another-history" });
  expect(() => local.journal.applyResults(session, changedReceipt, local.receive)).toThrow(
    /changed after validation/,
  );
  expect(local.journal.queued()).toMatchObject([{ attempt: { submissionId: "first" } }]);
  const ack = await client.push(session, sent);
  expect(() =>
    local.journal.applyResults(session, ack, (change) => {
      local.receive(change);
      throw new Error("transaction canceled");
    }),
  ).toThrow("transaction canceled");
  expect(local.get()).toBe(75);
  expect(local.journal.requiredRelease()).toBe("0.1");
  local.journal.applyResults(session, ack, (change) => {
    local.receive(change);
    if (change.state === "live") (change.content as Record<string, JsonValue>).kg = 99;
  });
  expect(local.get()).toBe(81);
  expect(local.journal.queued()).toEqual([]);
  expect(local.journal.history()).toMatchObject({ cursor: 3, revision: 3 });
  local.journal.commitLocal(key, edit("next", 82), () => local.set(82));
  expect(local.journal.queued()[0]?.base).toMatchObject({ revision: 3, content: { kg: 81 } });
  expect(local.journal.prepare(session)).toMatchObject([{ baseRevision: 3 }]);
});

test("a reconnect invalidates the previous journal session", async () => {
  using local = diary(":memory:");
  const client = createSyncClient({
    origin: "https://example.test",
    authorization: () => "Bearer synthetic",
    fetch: async () =>
      Response.json({
        release: "0.1",
        features: ["write-records"],
        accountBinding: "account",
        lineage: "fixture",
        revision: 0,
        restoredFrom: null,
      }),
  });
  const previous = await client.connect();
  local.journal.bind(previous);
  local.journal.commitLocal(key, edit("local", 75), () => local.set(75));
  const current = await client.connect();
  expect(() => local.journal.prepare(previous)).toThrow(
    expect.objectContaining({ code: "update-required" }),
  );
  expect(() => local.journal.bind(previous)).toThrow(
    expect.objectContaining({ code: "update-required" }),
  );
  local.journal.bind(current);
  expect(local.journal.prepare(current)).toMatchObject([{ submissionId: "local" }]);
});

test("in-flight records retain their protocol and reject invalid persisted targets and server moves", async () => {
  using local = diary(":memory:");
  const original = await candidateSession("0.1", undefined, undefined, "https://first.test/edo/");
  local.journal.bind(original);
  local.journal.commitLocal(key, edit("first", 75), () => local.set(75));
  const first = local.journal.prepare(original);
  expect(local.journal.requiredRelease()).toBe("0.1");
  const otherServer = await candidateSession(
    "0.1",
    undefined,
    undefined,
    "https://second.test/edo",
  );
  expect(() => local.journal.bind(otherServer)).toThrow(
    expect.objectContaining({ code: "account-changed" }),
  );
  expect(() => local.journal.prepare(otherServer)).toThrow(
    expect.objectContaining({ code: "update-required" }),
  );
  const newer = await candidateSession("0.2", undefined, undefined, "https://first.test/edo");
  local.journal.bind(newer);
  expect(() => local.journal.prepare(newer)).toThrow(
    expect.objectContaining({ code: "update-required" }),
  );
  expect(() => local.journal.prepare(original)).toThrow(
    expect.objectContaining({ code: "update-required" }),
  );
  local.journal.bind(original);
  expect(local.journal.prepare(original)).toEqual(first);
  local.sqlite.exec(
    "UPDATE edo_sync_outbox SET content = json_set(content, '$.attempt.id', 'other', '$.attempt.content.id', 'other')",
  );
  expect(() => local.journal.prepare(original)).toThrow(/outbox/i);
  expect(local.get()).toBe(75);
});
