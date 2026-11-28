import { expect, it } from "vitest";
import { createSyncClient } from "../src/index.ts";

const hello = {
  release: "0.1",
  features: ["write-records"],
  accountBinding: "fixture-a",
  lineage: "same-lineage",
  revision: 0,
  restoredFrom: null,
};

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
