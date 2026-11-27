import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import type { CatalogManifest } from "@edo/catalog-import";

async function openCatalogFile(path: string, label: "manifest" | "artifact") {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  return open(path, flags).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new Error(`Open Food Facts catalog ${label} must be a regular file`, { cause: error });
    }
    throw error;
  });
}

export async function readCatalogManifestFile(path: string): Promise<Buffer> {
  await using file = await openCatalogFile(path, "manifest");
  const metadata = await file.stat();
  if (!metadata.isFile())
    throw new Error("Open Food Facts catalog manifest must be a regular file");
  if (metadata.size <= 0 || metadata.size > 16 * 1024) {
    throw new Error("Open Food Facts catalog manifest has invalid size");
  }
  const buffer = Buffer.alloc(metadata.size + 1);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  if (bytesRead !== metadata.size) {
    throw new Error("Open Food Facts catalog manifest changed while being read");
  }
  return buffer.subarray(0, bytesRead);
}

export async function copyVerifiedCatalog(
  source: string,
  destination: string,
  artifact: CatalogManifest["artifact"],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await using file = await openCatalogFile(source, "artifact");
  const stat = await file.stat();
  if (!stat.isFile()) throw new Error("Open Food Facts catalog artifact must be a regular file");
  if (stat.size !== artifact.bytes) throw new Error("Open Food Facts catalog size is incorrect");

  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    file.createReadStream({ autoClose: false, start: 0 }),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        bytes += chunk.length;
        if (bytes > artifact.bytes) throw new Error("Open Food Facts catalog grew during copy");
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  if (bytes !== artifact.bytes || hash.digest("hex") !== artifact.sha256) {
    throw new Error("Open Food Facts catalog does not match its checksum");
  }
}

export async function validateCatalogSnapshot(
  path: string,
  manifest: CatalogManifest,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  // Validation scans the database before adoption without blocking other server requests.
  const worker = new Worker(new URL("./validate-catalog-worker.ts", import.meta.url), {
    workerData: { path, manifest },
  });
  const stop = () => {
    void worker.terminate().catch(() => undefined);
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      let failure: Error | undefined;
      worker.once("error", (error) => {
        failure = error;
      });
      worker.once("exit", (code) => {
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else reject(new Error(`Open Food Facts catalog validation exited with code ${code}`));
      });
    });
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
