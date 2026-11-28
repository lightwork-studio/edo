import { once } from "node:events";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { applyRecordContent } from "../src/record-projection.ts";
import { createHealthServer } from "../src/server.ts";
import { openSyncStore } from "../src/sync-store.ts";

const server = createHealthServer();
let url: URL;

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  url = new URL(`http://127.0.0.1:${address.port}`);
});

afterAll(async () => {
  await server[Symbol.asyncDispose]();
});

test("reports process liveness at GET /health", async () => {
  const response = await fetch(new URL("/health", url));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(await response.json()).toEqual({ status: "ok" });
});

test("reports unready while the process serves its development preview", async () => {
  const response = await fetch(new URL("/ready", url));
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "unavailable" });
});

test("probes the metadata of the open sync store and preserves process liveness", async () => {
  const directory = mkdtempSync(join(tmpdir(), "edo-sync-ready-"));
  try {
    const file = join(directory, "sync.sqlite");
    using store = openSyncStore(file, { applyContent: applyRecordContent });
    store.createAccount("synthetic-private-account", "synthetic-private-lineage");
    await using hosted = createHealthServer({
      sync: {
        store,
        authorize() {
          throw new Error("Readiness should never invoke account authorization");
        },
      },
    });
    hosted.listen(0, "127.0.0.1");
    await once(hosted, "listening");
    const address = hosted.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    const ready = await fetch(`${origin}/ready`);
    expect(ready.status).toBe(200);
    expect(ready.headers.get("cache-control")).toBe("no-store");
    expect(await ready.json()).toEqual({ status: "ready" });
    const head = await fetch(`${origin}/ready`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    using other = new DatabaseSync(file);
    other.exec("BEGIN EXCLUSIVE");
    try {
      const began = performance.now();
      const [firstProbe, secondProbe, health] = await Promise.all([
        fetch(`${origin}/ready`),
        fetch(`${origin}/ready`, { method: "HEAD" }),
        fetch(`${origin}/health`),
      ]);
      expect([firstProbe.status, secondProbe.status, health.status]).toEqual([503, 503, 200]);
      expect(performance.now() - began).toBeLessThan(1500);
    } finally {
      other.exec("ROLLBACK");
    }
    expect((await fetch(`${origin}/ready`)).status).toBe(200);
    other.exec("PRAGMA user_version = 999");
    const unavailable = await fetch(`${origin}/ready`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ status: "unavailable" });
    expect((await fetch(`${origin}/health`)).status).toBe(200);
    other.exec(`
      PRAGMA user_version = 2;
      DROP TABLE sync_receipts;
      CREATE TABLE sync_receipts (placeholder INTEGER);
    `);
    expect((await fetch(`${origin}/ready`)).status).toBe(503);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports the original store unready after its configured database is replaced", () => {
  const directory = mkdtempSync(join(tmpdir(), "edo-sync-moved-"));
  try {
    const file = join(directory, "sync.sqlite");
    using store = openSyncStore(file, { applyContent: applyRecordContent });
    expect(store.isReady()).toBe(true);
    renameSync(file, join(directory, "previous.sqlite"));
    expect(store.isReady()).toBe(false);
    using replacement = openSyncStore(file, { applyContent: applyRecordContent });
    expect(replacement.isReady()).toBe(true);
    expect(store.isReady()).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects requests to unknown routes and non-GET health requests", async () => {
  const unknownRoute = await fetch(new URL("/sync", url));
  const wrongMethod = await fetch(new URL("/health", url), { method: "POST" });

  expect(unknownRoute.status).toBe(404);
  expect(wrongMethod.status).toBe(404);
});
