import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import type { CatalogManifest } from "@edo/catalog-import";

export async function copyVerifiedCatalog(
  source: string,
  destination: string,
  artifact: CatalogManifest["artifact"],
): Promise<void> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const file = await open(source, flags).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new Error("Open Food Facts catalog artifact must be a regular file", { cause: error });
    }
    throw error;
  });
  await using ownedFile = file;
  const stat = await ownedFile.stat();
  if (!stat.isFile()) throw new Error("Open Food Facts catalog artifact must be a regular file");
  if (stat.size !== artifact.bytes) throw new Error("Open Food Facts catalog size is incorrect");

  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    ownedFile.createReadStream({ autoClose: false, start: 0 }),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        bytes += chunk.length;
        if (bytes > artifact.bytes) throw new Error("Open Food Facts catalog grew during copy");
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  if (bytes !== artifact.bytes || hash.digest("hex") !== artifact.sha256) {
    throw new Error("Open Food Facts catalog does not match its checksum");
  }
}

export async function validateCatalogSnapshot(path: string, manifest: CatalogManifest) {
  // Validation scans the database before adoption without blocking other server requests.
  const worker = new Worker(new URL("./validate-catalog-worker.ts", import.meta.url), {
    workerData: { path, manifest },
  });
  await new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Open Food Facts catalog validation exited with code ${code}`));
    });
  });
}
