import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openFoodFactsCatalog } from "./publish.ts";

export async function runCatalogJob<T>(
  root: string,
  run: (providerRoot: string) => Promise<T>,
): Promise<T> {
  const providerRoot = join(root, openFoodFactsCatalog.provider);
  await mkdir(providerRoot, { recursive: true });
  // SQLite releases the writer lock if the worker is terminated.
  using lock = new DatabaseSync(join(providerRoot, ".worker.sqlite"));
  try {
    lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  } catch (error) {
    if (error instanceof Error && "errcode" in error && error.errcode === 5) {
      throw new Error("Another Open Food Facts catalog job is running", { cause: error });
    }
    throw error;
  }
  return await run(providerRoot);
}
