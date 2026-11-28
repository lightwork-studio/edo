import { once } from "node:events";
import { decodeSubmission, type HelloResponse, syncScope } from "@edo/contract";
import { expect, it } from "vitest";
import { applyRecordContent } from "../../../apps/sync-node/src/record-projection.ts";
import { createHealthServer } from "../../../apps/sync-node/src/server.ts";
import { openSyncStore } from "../../../apps/sync-node/src/sync-store.ts";
import { createSyncClient } from "../src/index.ts";

const hello = {
  release: "0.1",
  features: ["write-records"],
  accountBinding: "fixture-a",
  lineage: "same-lineage",
  revision: 0,
  restoredFrom: null,
};

it("reviews a same-account restore without reviving the old upload session", async () => {
  const saved = {
    server: "https://example.test/team",
    accountBinding: hello.accountBinding,
    lineage: hello.lineage,
    revision: 7,
  };
  let reply: HelloResponse = { ...hello, revision: 7 };
  const sent: string[] = [];
  const features: string[][] = [];
  const client = createSyncClient({
    origin: saved.server,
    authorization: () => "Bearer synthetic",
    fetch: async (url, options) => {
      sent.push(new URL(String(url)).pathname);
      const request = JSON.parse(String(options?.body));
      features.push(request.features);
      return Response.json({ ...reply, features: request.features });
    },
  });
  const old = await client.connect(saved);
  const restore = { lineage: saved.lineage, revision: 3 };
  reply = { ...hello, lineage: "after-restore", revision: 3, restoredFrom: restore };
  expect(await client.reviewHistory(saved)).toEqual({
    status: "lineage-changed",
    server: saved.server,
    observed: { lineage: "after-restore", revision: 3, restoredFrom: restore },
  });
  await expect(client.pull(old, 0)).rejects.toMatchObject({ code: "update-required" });
  await expect(client.connect(saved)).rejects.toMatchObject({ code: "lineage-changed" });
  expect(sent).toEqual(["/team/sync/hello", "/team/sync/hello", "/team/sync/hello"]);
  expect(features).toEqual([["write-records"], [], ["write-records"]]);

  reply = { ...hello, revision: 6 };
  expect(await client.reviewHistory(saved)).toEqual({
    status: "cursor-reset",
    server: saved.server,
    observed: { lineage: saved.lineage, revision: 6, restoredFrom: null },
  });
  reply = { ...hello, revision: 9 };
  expect(await client.reviewHistory(saved)).toMatchObject({
    status: "same-history",
    observed: { revision: 9 },
  });
});

it("reviews a server move without forwarding source credentials or unrelated account history", async () => {
  const saved = {
    server: "https://original.test",
    accountBinding: hello.accountBinding,
    lineage: hello.lineage,
    revision: 0,
  };
  let requests = 0;
  let credentials = 0;
  const client = createSyncClient({
    origin: "https://destination.test",
    authorization: () => {
      credentials++;
      return "Bearer synthetic";
    },
    fetch: async () => {
      requests++;
      return Response.json({
        ...hello,
        features: [],
        accountBinding: "different-account",
        lineage: "other",
      });
    },
  });
  expect(await client.reviewHistory(saved)).toEqual({
    status: "server-moved",
    server: client.server,
  });
  expect([requests, credentials]).toEqual([0, 0]);
  expect(await client.reviewHistory({ ...saved, server: client.server })).toEqual({
    status: "account-changed",
    server: client.server,
  });
  expect([requests, credentials]).toEqual([1, 1]);
});

it("discards a recovery reply superseded by a new connection", async () => {
  const server = "https://example.test";
  let release: (reply: Response) => void = () => {};
  let announce: () => void = () => {};
  const waiting = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let requests = 0;
  const client = createSyncClient({
    origin: server,
    authorization: () => "Bearer synthetic",
    fetch: async () => {
      if (requests++ === 0) {
        announce();
        return waiting;
      }
      return Response.json(hello);
    },
  });
  const saved = { ...hello, server };
  const older = client.reviewHistory(saved);
  const discarded = expect(older).rejects.toMatchObject({ code: "account-changed" });
  await started;
  const connected = await client.connect(saved);
  release(Response.json({ ...hello, features: [], lineage: "late-restore" }));
  await discarded;
  expect(connected.lineage).toBe(saved.lineage);
});

it("the real sync server refuses writes after a read-only history review", async () => {
  using store = openSyncStore(":memory:", { applyContent: applyRecordContent });
  store.createAccount("account", "lineage");
  await using server = createHealthServer({
    sync: {
      store,
      authorize: (request) =>
        request.headers.authorization === "Bearer synthetic"
          ? { accountBinding: "account", sessionKey: "phone" }
          : null,
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  const origin = `http://127.0.0.1:${address.port}`;
  const client = createSyncClient({
    origin,
    allowLoopbackHttp: true,
    authorization: () => "Bearer synthetic",
  });
  const old = await client.connect();
  const saved = {
    server: client.server,
    accountBinding: old.accountBinding,
    lineage: old.lineage,
    revision: 0,
  };
  expect(await client.reviewHistory(saved)).toMatchObject({ status: "same-history" });
  const attempt = decodeSubmission({
    kind: "weigh-in",
    id: "weight",
    op: "put",
    submissionId: "weigh-in",
    baseRevision: null,
    content: {
      id: "weight",
      localDay: "2026-11-28",
      occurredAt: Date.parse("2026-11-28T13:00:00Z"),
      kg: 80,
    },
  });
  await expect(client.push(old, [attempt])).rejects.toMatchObject({ code: "update-required" });
  const refused = await fetch(`${origin}/sync/push`, {
    method: "POST",
    headers: { Authorization: "Bearer synthetic", "Content-Type": "application/json" },
    body: JSON.stringify({ ...syncScope(old), submissions: [attempt] }),
  });
  expect(await refused.json()).toMatchObject({ error: { code: "write-disabled" } });
  expect(store.history("account")?.revision).toBe(0);
  const connected = await client.connect(saved);
  expect((await client.push(connected, [attempt])).results).toEqual([
    { status: "accepted", submissionId: "weigh-in", revision: 1 },
  ]);
});

it("fences old in-flight replies and keeps a negotiated authorization pinned to that connection", async () => {
  let header = "Bearer synthetic-a";
  let resolvePending: (response: Response) => void = () => {
    throw new Error("Response not initialized");
  };
  const pending = new Promise<Response>((resolve) => {
    resolvePending = resolve;
  });
  const sent: { path: string; authorization: string | null }[] = [];
  const client = createSyncClient({
    origin: "https://example.test/team",
    authorization: () => header,
    fetch: async (input, options) => {
      const path = new URL(String(input)).pathname;
      const authorization = new Headers(options?.headers).get("Authorization");
      sent.push({ path, authorization });
      if (path.endsWith("/pull")) return pending;
      return Response.json({
        ...hello,
        accountBinding: authorization?.endsWith("a") ? "fixture-a" : "fixture-b",
      });
    },
  });
  const older = await client.connect();
  header = "Bearer synthetic-b";
  const forgotten = client.pull(older, 0);
  const refenced = expect(forgotten).rejects.toMatchObject({ code: "account-changed" });
  const current = await client.connect();
  expect(current.accountBinding).toBe("fixture-b");
  resolvePending(
    Response.json({
      release: "0.1",
      accountBinding: "fixture-a",
      lineage: "same-lineage",
      cursor: 0,
      hasMore: false,
      changes: [],
    }),
  );
  await refenced;
  await expect(client.pull(older, 0)).rejects.toMatchObject({ code: "update-required" });
  expect(sent).toEqual([
    { path: "/team/sync/hello", authorization: "Bearer synthetic-a" },
    { path: "/team/sync/pull", authorization: "Bearer synthetic-a" },
    { path: "/team/sync/hello", authorization: "Bearer synthetic-b" },
  ]);
});

it("rejects an oversized response and refuses insecure remote hosts", async () => {
  expect(() =>
    createSyncClient({
      origin: "http://example.test",
      allowLoopbackHttp: true,
      authorization: () => "Bearer test",
    }),
  ).toThrow(/secure/);
  expect(() =>
    createSyncClient({
      origin: "https://name:password@example.test",
      authorization: () => "Bearer test",
    }),
  ).toThrow(/secure/);
  const client = createSyncClient({
    origin: "https://example.test",
    authorization: () => "Bearer synthetic",
    fetch: async () => new Response("x".repeat(1_100_000)),
  });
  await expect(client.connect()).rejects.toMatchObject({ code: "unavailable" });
});

it("does not contact a new server with a previously bound diary", async () => {
  let credentialsRead = false;
  const client = createSyncClient({
    origin: "https://second.test/edo",
    authorization: () => {
      credentialsRead = true;
      return "Bearer synthetic";
    },
    fetch: async () => {
      throw new Error("Must not request a different server");
    },
  });
  await expect(
    client.connect({
      server: "https://first.test/edo",
      accountBinding: "fixture-a",
      lineage: "same-lineage",
      revision: 0,
    }),
  ).rejects.toMatchObject({ code: "account-changed" });
  expect(credentialsRead).toBe(false);
});
