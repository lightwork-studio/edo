import { expect, test } from "vitest";

test("resolves the @edo/contract entry point", async () => {
  await expect(import("@edo/contract")).resolves.toBeDefined();
});
