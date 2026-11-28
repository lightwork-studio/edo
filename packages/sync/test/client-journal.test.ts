import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Change } from "@edo/contract";
import { expect, test } from "vitest";
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
    a.journal.applyPage(sessionA, 0, await clientA.pull(sessionA, 0), a.receive);
    expect(a.get()).toBe(75);
    expect(a.journal.serverCopy(key)).toMatchObject({ revision: 2, content: { kg: 81 } });
    expect(() => a.journal.retryReviewed(key, 1, "a-2", "too-old")).toThrow(
      /changed during review/,
    );
    a.journal.commitLocal(key, edit("new-draft", 75), () => a.set(75));
    expect(() => a.journal.retryReviewed(key, 2, "a-2", "old-draft")).toThrow(/local edit changed/);
    expect(() => a.journal.retryReviewed(key, 2, "new-draft", "x".repeat(1025))).toThrow(
      expect.objectContaining({ code: "invalid-request" }),
    );
    a.journal.retryReviewed(key, 2, "new-draft", "a-3");
    const resolved = await clientA.push(sessionA, a.journal.prepare(sessionA));
    a.journal.applyResults(sessionA, resolved, a.receive);
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
  const ack = await client.push(session, sent);
  expect(() =>
    local.journal.applyResults(session, ack, (change) => {
      local.receive(change);
      throw new Error("transaction canceled");
    }),
  ).toThrow("transaction canceled");
  expect(local.get()).toBe(75);
  expect(local.journal.requiredRelease()).toBe("0.1");
  local.journal.applyResults(session, ack, local.receive);
  expect(local.get()).toBe(81);
  expect(local.journal.queued()).toEqual([]);
  expect(local.journal.history()).toMatchObject({ cursor: 3, revision: 3 });
  local.journal.commitLocal(key, edit("next", 82), () => local.set(82));
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
