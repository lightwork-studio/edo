import { expect, test } from "vitest";

test("resolves the @edo/core entry point", async () => {
  await expect(import("@edo/core")).resolves.toBeDefined();
});
