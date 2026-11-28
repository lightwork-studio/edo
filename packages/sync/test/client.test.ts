import { once } from "node:events";
import { decodeSubmission, type HelloResponse } from "@edo/contract";
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
  expect(sent).toEqual(["/team/sync/hello", "/team/sync/history", "/team/sync/hello"]);
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

it("reads recovery against the binding present before the request", async () => {
  const server = "https://example.test";
  const saved = { ...hello, revision: 5, server };
  const client = createSyncClient({
    origin: server,
    authorization: () => "Bearer synthetic",
    fetch: async () => {
      saved.accountBinding = "other-account";
      saved.revision = 30;
      return Response.json({ ...hello, features: [], revision: 6 });
    },
  });
  expect(await client.reviewHistory(saved)).toMatchObject({
    status: "same-history",
    observed: { revision: 6 },
  });
});

it("discards a malformed recovery reply superseded by a new connection", async () => {
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
  release(new Response("malformed reply"));
  await discarded;
  expect(connected.lineage).toBe(saved.lineage);
});

it("requires an updated server for history review while supporting its existing connection", async () => {
  const server = "https://example.test";
  const sent: string[] = [];
  const client = createSyncClient({
    origin: server,
    authorization: () => "Bearer synthetic",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      sent.push(path);
      return path === "/sync/hello"
        ? Response.json(hello)
        : new Response("Not found", { status: 404 });
    },
  });
  const saved = { ...hello, server };
  await expect(client.reviewHistory(saved)).rejects.toMatchObject({ code: "update-required" });
  expect(sent).toEqual(["/sync/history"]);
  await expect(client.connect(saved)).resolves.toMatchObject(hello);
});

it("the real sync server keeps history review independent of the writable negotiation", async () => {
  using store = openSyncStore(":memory:", { applyContent: applyRecordContent });
  store.createAccount("account", "lineage");
  let announce = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holdReview = false;
  let authChecks = 0;
  await using server = createHealthServer({
    sync: {
      store,
      authorize: async (request) => {
        if (request.headers.authorization !== "Bearer synthetic") return null;
        if (holdReview && request.url === "/sync/history" && ++authChecks === 2) {
          announce();
          await waiting;
        }
        return { accountBinding: "account", sessionKey: "phone" };
      },
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
  const saved = {
    server: client.server,
    accountBinding: "account",
    lineage: "lineage",
    revision: 0,
  };
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
  expect(await client.reviewHistory(saved)).toMatchObject({ status: "same-history" });
  const headers = { Authorization: "Bearer synthetic", "Content-Type": "application/json" };
  const denied = await fetch(`${origin}/sync/history`, {
    method: "POST",
    headers: { ...headers, Authorization: "Bearer invalid" },
    body: JSON.stringify({ releases: [hello.release], features: [] }),
  });
  expect(denied.status).toBe(401);
  expect(await denied.json()).toMatchObject({ error: { code: "unauthorized" } });
  const advertised = await fetch(`${origin}/sync/history`, {
    method: "POST",
    headers,
    body: JSON.stringify({ releases: [hello.release], features: hello.features }),
  });
  expect(await advertised.json()).toMatchObject({ features: [] });
  const refused = await fetch(`${origin}/sync/push`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      accountBinding: saved.accountBinding,
      lineage: saved.lineage,
      release: hello.release,
      submissions: [attempt],
    }),
  });
  expect(await refused.json()).toMatchObject({ error: { code: "update-required" } });
  expect(store.history("account")?.revision).toBe(0);

  const old = await client.connect(saved);
  holdReview = true;
  const discarded = expect(client.reviewHistory(saved)).rejects.toMatchObject({
    code: "account-changed",
  });
  try {
    await started;
    await expect(client.push(old, [attempt])).rejects.toMatchObject({ code: "update-required" });
    const connected = await client.connect(saved);
    release();
    await discarded;
    expect((await client.push(connected, [attempt])).results).toEqual([
      { status: "accepted", submissionId: "weigh-in", revision: 1 },
    ]);
  } finally {
    release();
  }
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
