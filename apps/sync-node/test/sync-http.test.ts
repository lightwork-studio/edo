import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptHello, decodePullResponse, decodePushResponse } from "@edo/contract";
import { expect, it, vi } from "vitest";
import { applyRecordContent } from "../src/record-projection.ts";
import { createHealthServer } from "../src/server.ts";
import type { SyncAccess } from "../src/sync-http.ts";
import { openSyncStore, type SyncStore } from "../src/sync-store.ts";

const hello = { releases: ["0.1"], features: ["write-records"] };
const scope = { release: "0.1", accountBinding: "fixture-a", lineage: "fixture-history" };
const record = {
  op: "put",
  submissionId: "save-weight",
  kind: "weigh-in",
  id: "weight",
  baseRevision: null,
  content: { id: "weight", localDay: "2026-11-27", occurredAt: 1795780800000, kg: 74.25 },
} as const;

async function withEndpoint(
  store: SyncStore,
  sessions: Map<string, SyncAccess>,
  run: (send: (path: string, key: string, body: unknown) => Promise<Response>) => Promise<void>,
) {
  let switchingCalls = 0;
  const server = createHealthServer({
    sync: {
      store,
      authorize(request) {
        const id = request.headers["x-fixture-session"];
        const access = typeof id === "string" ? (sessions.get(id) ?? null) : null;
        if (id === "revoking-fixture") sessions.delete(id);
        if (id === "switching-fixture" && access && switchingCalls++ > 0) {
          Object.assign(access, { accountBinding: "fixture-b" });
        }
        return access;
      },
    },
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback address");
    await run((operation, key, body) =>
      fetch(`http://127.0.0.1:${address.port}/sync/${operation}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-fixture-session": key },
        body: JSON.stringify(body),
      }),
    );
  } finally {
    await server[Symbol.asyncDispose]();
  }
}

it("scopes HTTP sync to authenticated negotiated accounts and replays receipts after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "edo-local-sync-"));
  const path = join(dir, "sync.sqlite");
  const access = new Map([
    ["a", { accountBinding: "fixture-a", sessionKey: "session-a" }],
    ["b", { accountBinding: "fixture-b", sessionKey: "session-b" }],
  ]);
  const push = { ...scope, submissions: [record] };
  try {
    {
      using store = openSyncStore(path, { applyContent: applyRecordContent });
      store.createAccount("fixture-a", scope.lineage);
      store.createAccount("fixture-b", scope.lineage);
      const readHistory = vi.spyOn(store, "history");
      await withEndpoint(store, access, async (send) => {
        expect((await send("hello", "untrusted", hello)).status).toBe(401);
        access.set("switching-fixture", { accountBinding: "fixture-a", sessionKey: "session-a" });
        const historyReads = readHistory.mock.calls.length;
        expect((await send("hello", "switching-fixture", hello)).status).toBe(401);
        expect(readHistory).toHaveBeenCalledTimes(historyReads);
        expect((await send("push", "a", push)).status).toBe(426);
        expect((await send("hello", "a", { ...hello, releases: ["9.9"] })).status).toBe(426);
        const first = await send("hello", "a", hello);
        expect(first.status).toBe(200);
        const client = acceptHello(hello, await first.json());
        const response = await send("push", "a", push);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(decodePushResponse(await response.json(), push, client).results).toEqual([
          { status: "accepted", submissionId: record.submissionId, revision: 1 },
        ]);
        expect((await send("hello", "b", hello)).status).toBe(200);
        const wrongAccount = await send("push", "b", push);
        expect(wrongAccount.status).toBe(409);
        expect(await wrongAccount.json()).toMatchObject({ error: { code: "account-changed" } });
        const bob = await send("pull", "b", {
          ...scope,
          accountBinding: "fixture-b",
          cursor: 0,
        });
        expect(await bob.json()).toMatchObject({ cursor: 0, changes: [] });
        const invalid = {
          ...record,
          submissionId: "invalid-weight",
          baseRevision: 1,
          content: { ...record.content, kg: -1 },
        };
        const rejected = await send("push", "a", { ...scope, submissions: [invalid] });
        expect(await rejected.json()).toMatchObject({
          results: [{ status: "rejected", code: "invalid-content" }],
        });
        const huge = await send("push", "a", {
          ...scope,
          submissions: [{ ...record, content: { id: "x".repeat(800_000) } }],
        });
        expect(huge.status).toBe(413);
        access.set("revoking-fixture", { accountBinding: "fixture-a", sessionKey: "session-a" });
        const revoked = await send("push", "revoking-fixture", {
          ...scope,
          submissions: [
            {
              ...record,
              submissionId: "revoked-write",
              baseRevision: 1,
              content: { ...record.content, kg: 81 },
            },
          ],
        });
        expect(revoked.status).toBe(401);
        expect(store.history("fixture-a")?.revision).toBe(1);
      });
    }
    {
      using store = openSyncStore(path, { applyContent: applyRecordContent });
      await withEndpoint(store, access, async (send) => {
        expect((await send("push", "a", push)).status).toBe(426);
        const reconnected = await send("hello", "a", hello);
        const client = acceptHello(hello, await reconnected.json());
        expect(client.revision).toBe(1);
        const repeated = await send("push", "a", push);
        expect(decodePushResponse(await repeated.json(), push, client).results).toEqual([
          { status: "accepted", submissionId: record.submissionId, revision: 1 },
        ]);
        const request = { ...scope, cursor: 0 };
        const page = await send("pull", "a", request);
        expect(decodePullResponse(await page.json(), request, client)).toMatchObject({
          cursor: 1,
          hasMore: false,
          changes: [
            { state: "live", kind: "weigh-in", id: "weight", content: record.content, revision: 1 },
          ],
        });
        expect((await send("pull", "a", { ...scope, cursor: 2 })).status).toBe(409);
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("leaves sync routes disabled with default health server settings", async () => {
  const server = createHealthServer();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback address");
    const response = await fetch(`http://127.0.0.1:${address.port}/sync/hello`, { method: "POST" });
    expect(response.status).toBe(404);
  } finally {
    await server[Symbol.asyncDispose]();
  }
});
