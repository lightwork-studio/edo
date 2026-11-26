import { expect, test } from "vitest";

test("resolves the @edo/sync entry point", async () => {
  await expect(import("@edo/sync")).resolves.toBeDefined();
});
