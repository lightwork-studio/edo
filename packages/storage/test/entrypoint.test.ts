import { expect, test } from "vitest";

test("resolves the @edo/storage entry point", async () => {
  await expect(import("@edo/storage")).resolves.toBeDefined();
});
