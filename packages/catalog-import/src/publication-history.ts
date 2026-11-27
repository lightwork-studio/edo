import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CatalogProvider, isCatalogManifest, isCatalogProvider } from "./manifest.ts";

const receiptDirectory = "published";
const receiptName = /^([a-f0-9]{64})\.sha256$/;

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

async function readRegularFile(path: string): Promise<Buffer | null> {
  try {
    await using file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    return (await file.stat()).isFile() ? await file.readFile() : null;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ELOOP") return null;
    throw error;
  }
}

async function realDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function activeReleaseDigest(
  root: string,
  provider: CatalogProvider,
): Promise<string | null> {
  if (!(await realDirectory(root)) || !(await realDirectory(join(root, "releases")))) return null;
  const active = await readRegularFile(join(root, "active.json"));
  if (!active) return null;
  try {
    const manifest: unknown = JSON.parse(active.toString("utf8"));
    if (!isCatalogManifest(manifest) || manifest.provider !== provider) return null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }

  const digest = createHash("sha256").update(active).digest("hex");
  const immutable = await readRegularFile(join(root, "releases", `${digest}.json`));
  return immutable?.equals(active) ? digest : null;
}

/** Preserve evidence that the current release was activated before the pointer is replaced. */
export async function archiveCurrentCatalogRelease(
  root: string,
  stage: string,
  provider: CatalogProvider,
  nextDigest: string,
): Promise<void> {
  const previous = await activeReleaseDigest(root, provider);
  if (!previous || previous === nextDigest) return;

  const directory = join(root, receiptDirectory);
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Catalog receipt directory must be a real directory");
  const receipt = join(directory, `${previous}.sha256`);
  const body = `${previous}\n`;
  if ((await readRegularFile(receipt))?.toString("utf8") !== body) {
    const pending = join(stage, "published.sha256");
    await writeFile(pending, body, { flush: true });
    await rename(pending, receipt);
  }
  if (process.platform !== "win32") {
    // The prior attempt may have stopped after rename and before this directory was durable.
    await using handle = await open(directory);
    await handle.sync();
  }
}

/** Return current and previously activated digests. Callers verify the corresponding artifacts. */
export async function listPublishedCatalogReleases(
  root: string,
  provider: CatalogProvider,
): Promise<string[]> {
  if (!isCatalogProvider(provider)) throw new Error("Unknown catalog provider");
  const providerRoot = join(root, provider);
  if (!(await realDirectory(providerRoot))) return [];
  const committed = new Set<string>();
  const active = await activeReleaseDigest(providerRoot, provider);
  if (active) committed.add(active);

  const directory = join(providerRoot, receiptDirectory);
  let receipts: string[];
  try {
    if (!(await lstat(directory)).isDirectory())
      throw new Error("Catalog receipt directory must be a real directory");
    receipts = await readdir(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [...committed];
    throw error;
  }
  for (const filename of receipts) {
    const digest = filename.match(receiptName)?.[1];
    if (!digest) continue;
    const body = await readRegularFile(join(directory, filename));
    if (body?.toString("utf8") === `${digest}\n`) committed.add(digest);
  }
  return [...committed];
}
