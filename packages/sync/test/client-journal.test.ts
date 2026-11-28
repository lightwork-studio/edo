import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Change, negotiateHello } from "@edo/contract";
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
  const set = (weight: number) =>
    connection.run("INSERT OR REPLACE INTO diary_fixture VALUES (?, ?)", key.id, weight);
  return {
    sqlite,
    journal: openSyncJournal(connection),
    set,
    get: () => connection.get("SELECT kg FROM diary_fixture WHERE id = ?", key.id)?.kg ?? null,
    receive(change: Change) {
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

test("local edits roll back with failed queue writes", () => {
  using local = diary(":memory:");
  const hello = negotiateHello(
    { releases: ["0.1"], features: ["write-records"] },
    {
      accountBinding: "account",
      lineage: "fixture",
      revision: 0,
      restoredFrom: null,
    },
  );
  if (hello.status !== "ready") throw new Error("Fixture cannot negotiate");
  local.journal.bind(hello.session, "https://example.test");
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
  expect(local.journal.prepare(hello.session)).toMatchObject([
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
      a.journal.bind(session, clientA.server);
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
    a.journal.bind(sessionA, clientA.server);
    b.journal.bind(sessionB, clientB.server);
    const resumed = a.journal.prepare(sessionA);
    expect(resumed).toEqual(lost);
    const ack = await clientA.push(sessionA, resumed);
    a.journal.applyResults(sessionA, ack.results, a.receive);
    a.journal.applyResults(sessionA, ack.results, a.receive);
    expect(a.journal.history()).toMatchObject({ revision: 1, cursor: 0 });
    expect(a.journal.queued()).toMatchObject([
      { pending: { submissionId: "a-2" }, baseRevision: 1 },
    ]);

    b.journal.applyPage(sessionB, 0, await clientB.pull(sessionB, 0), b.receive);
    expect(b.get()).toBe(74);
    b.journal.commitLocal(key, edit("b-1", 81), () => b.set(81));
    const changed = await clientB.push(sessionB, b.journal.prepare(sessionB));
    b.journal.applyResults(sessionB, changed.results, b.receive);
    expect(b.journal.history()).toMatchObject({ revision: 2, cursor: 1 });
    const nextA = a.journal.prepare(sessionA);
    expect(nextA).toMatchObject([{ submissionId: "a-2", baseRevision: 1 }]);
    const conflict = await clientA.push(sessionA, nextA);
    a.journal.applyResults(sessionA, conflict.results, a.receive);
    expect(a.journal.queued()).toMatchObject([
      { blocked: { result: { status: "conflict", current: { revision: 2 } } } },
    ]);
    a.journal.applyPage(sessionA, 0, await clientA.pull(sessionA, 0), a.receive);
    expect(a.get()).toBe(75);
    expect(a.journal.serverCopy(key)).toMatchObject({ revision: 2, content: { kg: 81 } });
    expect(() => a.journal.retryReviewed(key, 1, "too-old")).toThrow(/changed during review/);
    a.journal.retryReviewed(key, 2, "a-3");
    const resolved = await clientA.push(sessionA, a.journal.prepare(sessionA));
    a.journal.applyResults(sessionA, resolved.results, a.receive);
    expect(a.journal.history()).toMatchObject({ revision: 3, cursor: 2 });
    expect(a.journal.queued()).toEqual([]);

    const page = await clientB.pull(sessionB, 1);
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
) {
  const registry = [{ release, features: ["write-records"], writableKinds }];
  const hello = negotiateHello(
    { releases: [release], features },
    {
      accountBinding: "account",
      lineage: "fixture",
      revision: 0,
      restoredFrom: null,
    },
    registry,
  );
  if (hello.status !== "ready") throw new Error("Fixture cannot negotiate");
  return hello.session;
}

test("an unnegotiated session cannot bind a private diary", () => {
  using local = diary(":memory:");
  const session = candidateSession();
  expect(() => local.journal.bind({ ...session }, "https://example.test")).toThrow(
    expect.objectContaining({ code: "update-required" }),
  );
  expect(local.journal.history()).toBeNull();
  local.journal.bind(session, "https://example.test");
  expect(local.journal.history()).toMatchObject({ accountBinding: "account" });
});

test("read-only and incompatible releases leave a pending edit unpinned for reconnection", () => {
  using local = diary(":memory:");
  const server = "https://example.test";
  const readOnly = candidateSession("0.1", []);
  local.journal.bind(readOnly, server);
  local.journal.commitLocal(key, edit("first", 75), () => local.set(75));
  expect(() => local.journal.prepare(readOnly)).toThrow(
    expect.objectContaining({ code: "write-disabled" }),
  );

  const incompatible = candidateSession("0.2", ["write-records"], ["meal"]);
  local.journal.bind(incompatible, server);
  expect(() => local.journal.prepare(incompatible)).toThrow(
    expect.objectContaining({ code: "update-required" }),
  );
  expect(local.get()).toBe(75);
  expect(local.journal.requiredRelease()).toBeNull();
  expect(local.journal.queued()).toMatchObject([{ pending: { submissionId: "first" } }]);

  const writable = candidateSession("0.3");
  local.journal.bind(writable, server);
  expect(local.journal.prepare(writable)).toMatchObject([{ submissionId: "first" }]);
  expect(local.journal.requiredRelease()).toBe("0.3");
});

test("a late receipt atomically applies a newer remote copy already delivered during flight", () => {
  using local = diary(":memory:");
  const session = candidateSession();
  local.journal.bind(session, "https://example.test");
  local.journal.commitLocal(key, edit("first", 75), () => local.set(75));
  local.journal.prepare(session);
  local.journal.applyPage(
    session,
    0,
    {
      release: "0.1",
      accountBinding: "account",
      lineage: "fixture",
      cursor: 3,
      hasMore: false,
      changes: [{ state: "live", ...key, revision: 3, content: edit("ignored", 81).content }],
    },
    local.receive,
  );
  expect(local.get()).toBe(75);
  expect(local.journal.history()?.cursor).toBe(3);
  const ack = [{ status: "accepted", submissionId: "first", revision: 2 }] as const;
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

test("in-flight records retain their protocol and reject invalid persisted targets and server moves", () => {
  using local = diary(":memory:");
  const original = candidateSession();
  local.journal.bind(original, "https://first.test/edo/");
  local.journal.commitLocal(key, edit("first", 75), () => local.set(75));
  const first = local.journal.prepare(original);
  expect(local.journal.requiredRelease()).toBe("0.1");
  expect(() => local.journal.bind(original, "https://second.test/edo")).toThrow(
    expect.objectContaining({ code: "account-changed" }),
  );
  const newer = candidateSession("0.2");
  local.journal.bind(newer, "https://first.test/edo");
  expect(() => local.journal.prepare(newer)).toThrow(
    expect.objectContaining({ code: "update-required" }),
  );
  expect(() => local.journal.prepare(original)).toThrow(
    expect.objectContaining({ code: "update-required" }),
  );
  local.journal.bind(original, "https://first.test/edo");
  expect(local.journal.prepare(original)).toEqual(first);
  local.sqlite.exec(
    "UPDATE edo_sync_outbox SET content = json_set(content, '$.attempt.id', 'other', '$.attempt.content.id', 'other')",
  );
  expect(() => local.journal.prepare(original)).toThrow(/outbox/i);
  expect(local.get()).toBe(75);
});
