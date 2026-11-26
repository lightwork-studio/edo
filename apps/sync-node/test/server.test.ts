import { once } from "node:events";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createHealthServer } from "../src/server.ts";

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

test("reports readiness at GET /health", async () => {
  const response = await fetch(new URL("/health", url));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(await response.json()).toEqual({ status: "ok" });
});

test("rejects requests to unknown routes and non-GET health requests", async () => {
  const unknownRoute = await fetch(new URL("/sync", url));
  const wrongMethod = await fetch(new URL("/health", url), { method: "POST" });

  expect(unknownRoute.status).toBe(404);
  expect(wrongMethod.status).toBe(404);
});
