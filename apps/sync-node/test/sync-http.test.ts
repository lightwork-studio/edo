import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptHello,
  decodePullResponse,
  decodePushResponse,
  type SyncRelease,
  syncCandidate,
} from "@edo/contract";
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
  releases?: readonly SyncRelease[],
) {
  let switchingCalls = 0;
  const server = createHealthServer({
    sync: {
      store,
      releases,
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

it("preserves newer record fields through a previous client and falls back on an older server", async () => {
  // An unpublished release fixture adds one opaque field and capability for this matrix.
  const next: SyncRelease = {
    ...syncCandidate,
    release: "0.2",
    features: [...syncCandidate.features, "fixture-metadata"],
  };
  const nextHello = { releases: [next.release, syncCandidate.release], features: next.features };
  const nextScope = { ...scope, release: next.release };
  const access = new Map([
    ["old", { accountBinding: scope.accountBinding, sessionKey: "old-device" }],
    ["new", { accountBinding: scope.accountBinding, sessionKey: "new-device" }],
  ]);
  const opaque = { status: null, repeated: [0, false], note: "retained metadata" };
  using store = openSyncStore(":memory:", {
    applyContent(input) {
      if (input.release !== next.release) return applyRecordContent(input);
      const { fixtureMetadata, ...submitted } = input.submitted;
      const saved = applyRecordContent({ ...input, release: syncCandidate.release, submitted });
      return fixtureMetadata === undefined ? saved : { ...saved, fixtureMetadata };
    },
  });
  store.createAccount(scope.accountBinding, scope.lineage);
  await withEndpoint(
    store,
    access,
    async (send) => {
      const nextReply = await send("hello", "new", nextHello);
      const currentPeer = acceptHello(nextHello, await nextReply.json(), undefined, [
        next,
        syncCandidate,
      ]);
      expect(currentPeer).toMatchObject({ release: next.release, features: next.features });
      const newerPut = {
        ...nextScope,
        submissions: [{ ...record, content: { ...record.content, fixtureMetadata: opaque } }],
      };
      const created = await send("push", "new", newerPut);
      expect(decodePushResponse(await created.json(), newerPut, currentPeer).results).toEqual([
        { status: "accepted", submissionId: record.submissionId, revision: 1 },
      ]);

      const previousReply = await send("hello", "old", hello);
      const previousPeer = acceptHello(hello, await previousReply.json());
      expect(previousPeer).toMatchObject({
        release: syncCandidate.release,
        features: syncCandidate.features,
        revision: 1,
      });
      const previousPull = { ...scope, cursor: 0 };
      const pulled = await send("pull", "old", previousPull);
      expect(decodePullResponse(await pulled.json(), previousPull, previousPeer).changes).toEqual([
        {
          kind: record.kind,
          id: record.id,
          state: "live",
          revision: 1,
          content: { ...record.content, fixtureMetadata: opaque },
        },
      ]);
      // The older client changes only the field it understands and omits the new field.
      const previousPut = {
        ...scope,
        submissions: [
          {
            ...record,
            submissionId: "old-edit",
            baseRevision: 1,
            content: { ...record.content, kg: 74.5 },
          },
        ],
      };
      const updated = await send("push", "old", previousPut);
      expect(decodePushResponse(await updated.json(), previousPut, previousPeer).results).toEqual([
        { status: "accepted", submissionId: "old-edit", revision: 2 },
      ]);
      const recentPull = { ...nextScope, cursor: 1 };
      const recent = await send("pull", "new", recentPull);
      expect(decodePullResponse(await recent.json(), recentPull, currentPeer)).toMatchObject({
        cursor: 2,
        changes: [{ revision: 2, content: { kg: 74.5, fixtureMetadata: opaque } }],
      });
    },
    [next, syncCandidate],
  );

  await withEndpoint(store, access, async (send) => {
    const fallbackReply = await send("hello", "new", nextHello);
    const fallback = acceptHello(
      nextHello,
      await fallbackReply.json(),
      { accountBinding: scope.accountBinding, lineage: scope.lineage, revision: 2 },
      [next, syncCandidate],
    );
    expect(fallback).toMatchObject({
      release: syncCandidate.release,
      features: syncCandidate.features,
      revision: 2,
    });
    const fallbackPull = { ...scope, cursor: 1 };
    const fallbackPage = await send("pull", "new", fallbackPull);
    expect(fallbackPage.status).toBe(200);
    expect(decodePullResponse(await fallbackPage.json(), fallbackPull, fallback)).toMatchObject({
      cursor: 2,
      changes: [{ revision: 2, content: { kg: 74.5, fixtureMetadata: opaque } }],
    });
    const incompatible = await send("hello", "new", { ...nextHello, releases: [next.release] });
    expect(incompatible.status).toBe(426);
    expect(await incompatible.json()).toEqual({
      status: "update-required",
      supportedReleases: [syncCandidate.release],
    });
    expect((await send("pull", "new", { ...scope, cursor: 0 })).status).toBe(426);
    const refused = await send("push", "new", {
      ...scope,
      submissions: [
        {
          ...record,
          submissionId: "new-edit-after-incompatible-hello",
          baseRevision: 2,
          content: { ...record.content, kg: 76 },
        },
      ],
    });
    expect(refused.status).toBe(426);
    expect(store.history(scope.accountBinding)?.revision).toBe(2);
  });
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
