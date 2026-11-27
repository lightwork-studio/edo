import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type CatalogManifest, isCatalogManifest, isCatalogProvider } from "./manifest.ts";

export * from "./manifest.ts";

interface CatalogImportMetadata
  extends Pick<CatalogManifest, "provider" | "schemaVersion" | "importerVersion" | "attribution"> {
  root: string;
  source: Omit<CatalogManifest["source"], "sha256">;
}

export interface CatalogImportInput extends CatalogImportMetadata {
  /** A complete, stable input file, such as a downloaded archive. */
  inputPath: string;
}

export interface PreparedCatalogImportInput extends CatalogImportMetadata {
  /** Write and close a regular file at the supplied private path without linking to another file. */
  prepareInput(destination: string): Promise<void>;
}

export interface CatalogBuilder {
  /** Close all writer connections and finish any SQLite journals before returning. */
  build(inputPath: string, artifactPath: string): Promise<CatalogManifest["counts"]>;
  /** Check the staged file using the provider's schema and row-level invariants. */
  validate(artifactPath: string, counts: CatalogManifest["counts"]): Promise<void>;
}

async function fileDigest(path: string): Promise<CatalogManifest["artifact"]> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

function isAlreadyPresent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function installImmutable(
  staged: string,
  destination: string,
  expected: CatalogManifest["artifact"],
): Promise<void> {
  try {
    await link(staged, destination);
  } catch (error) {
    if (!isAlreadyPresent(error)) throw error;
    const existing = (await lstat(destination)).isFile() ? await fileDigest(destination) : null;
    if (existing?.sha256 !== expected.sha256 || existing?.bytes !== expected.bytes) {
      throw new Error(`Stored catalog file does not match its checksum: ${basename(destination)}`);
    }
  }
}

function verifyDatabase(path: string, schemaVersion: number): void {
  using database = new DatabaseSync(path, { readOnly: true });
  const journal = database.prepare("PRAGMA journal_mode").get();
  const version = database.prepare("PRAGMA user_version").get();
  if (journal?.journal_mode !== "delete") {
    throw new Error("Published catalog must use SQLite DELETE journal mode");
  }
  if (version?.user_version !== schemaVersion) {
    throw new Error("Catalog SQLite schema does not match the manifest");
  }
}

async function syncFile(path: string): Promise<void> {
  await using file = await open(path, "r");
  await file.sync();
}

function managedSourcePath(providerRoot: string): string {
  return join(providerRoot, ".catalog-managed-source");
}

function lockPublisher(providerRoot: string): DatabaseSync {
  // SQLite releases the provider's writer lock even if an import process is terminated.
  const lock = new DatabaseSync(join(providerRoot, ".publisher.sqlite"));
  try {
    lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    return lock;
  } catch (error) {
    lock.close();
    throw error;
  }
}

/** Reclaim the producer-owned raw file even if the next run finds an unchanged release. */
export async function clearPreparedCatalogSource(
  root: string,
  provider: CatalogManifest["provider"],
): Promise<void> {
  if (!isCatalogProvider(provider)) throw new Error("Unknown catalog provider");
  const providerRoot = join(root, provider);
  const path = managedSourcePath(providerRoot);
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  using _lock = lockPublisher(providerRoot);
  await rm(path, { force: true });
}

async function copySource(inputPath: string, stage: string): Promise<string> {
  const inputFile = await realpath(inputPath);
  if (!(await stat(inputFile)).isFile()) throw new Error("Catalog input must be a regular file");
  const stagedSource = join(stage, "source");
  await mkdir(stagedSource);
  const snapshot = join(stagedSource, basename(inputFile));
  await copyFile(inputFile, snapshot, constants.COPYFILE_FICLONE);
  return snapshot;
}

/** Serialize writers per provider. Independent providers use separate activation pointers. */
export async function publishCatalog(
  input: CatalogImportInput | PreparedCatalogImportInput,
  builder: CatalogBuilder,
): Promise<CatalogManifest> {
  if (!isCatalogProvider(input.provider)) throw new Error("Unknown catalog provider");

  const root = join(input.root, input.provider);
  const artifacts = join(root, "artifacts");
  const releases = join(root, "releases");
  await mkdir(artifacts, { recursive: true });
  await mkdir(releases, { recursive: true });
  using _lock = lockPublisher(root);
  const stage = await mkdtemp(join(root, ".stage-"));
  const managed = !("inputPath" in input);
  const managedSource = managedSourcePath(root);
  try {
    if (managed) {
      await rm(managedSource, { force: true });
      await input.prepareInput(managedSource);
    }
    const snapshot = managed ? managedSource : await copySource(input.inputPath, stage);
    const original = await lstat(snapshot, { bigint: true });
    if (!original.isFile() || original.nlink !== 1n) {
      throw new Error("Catalog source must be a regular file with a single link");
    }
    const source = await fileDigest(snapshot);
    const stagedDatabase = join(stage, "catalog.sqlite");
    const counts = await builder.build(snapshot, stagedDatabase);
    await builder.validate(stagedDatabase, counts);
    const final = await lstat(snapshot, { bigint: true });
    if (
      !final.isFile() ||
      final.nlink !== 1n ||
      original.dev !== final.dev ||
      original.ino !== final.ino ||
      original.size !== final.size ||
      original.mtimeNs !== final.mtimeNs ||
      original.ctimeNs !== final.ctimeNs
    ) {
      throw new Error("Catalog input changed during import");
    }
    const entries = await readdir(stage);
    if (
      !(await lstat(stagedDatabase)).isFile() ||
      entries.some((item) => /^catalog\.sqlite-(journal|shm|wal)$/.test(item))
    ) {
      throw new Error("Catalog must be a standalone SQLite file");
    }
    verifyDatabase(stagedDatabase, input.schemaVersion);
    const artifact = await fileDigest(stagedDatabase);
    const manifest: CatalogManifest = {
      manifestVersion: 1,
      provider: input.provider,
      schemaVersion: input.schemaVersion,
      importerVersion: input.importerVersion,
      source: {
        release: input.source.release,
        url: input.source.url,
        sha256: source.sha256,
        ...(input.source.lastModified !== undefined && { lastModified: input.source.lastModified }),
      },
      attribution: {
        name: input.attribution.name,
        license: input.attribution.license,
        changes: input.attribution.changes,
      },
      artifact,
      counts: {
        accepted: counts.accepted,
        rejected: counts.rejected,
        ...(counts.skipped !== undefined && { skipped: counts.skipped }),
      },
    };
    if (!isCatalogManifest(manifest)) throw new Error("Invalid catalog release manifest");

    await syncFile(stagedDatabase);
    await installImmutable(stagedDatabase, join(artifacts, `${artifact.sha256}.sqlite`), artifact);
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const releaseDigest = {
      sha256: createHash("sha256").update(manifestText).digest("hex"),
      bytes: Buffer.byteLength(manifestText),
    };
    const stagedRelease = join(stage, "release.json");
    await writeFile(stagedRelease, manifestText, { flush: true });
    await installImmutable(
      stagedRelease,
      join(releases, `${releaseDigest.sha256}.json`),
      releaseDigest,
    );

    const activation = join(stage, "active.json");
    await writeFile(activation, manifestText, { flush: true });
    if (process.platform !== "win32") {
      // Order immutable files and their directory entries before publishing the pointer.
      await Promise.all([syncFile(artifacts), syncFile(releases)]);
      await syncFile(root);
    }
    await rename(activation, join(root, "active.json"));
    if (process.platform !== "win32") {
      // The rename is the commit point. A flush error here leaves both releases recoverable.
      await syncFile(root).catch(() => undefined);
    }
    return manifest;
  } finally {
    // Cleanup must preserve the import result and must not mask the underlying failure.
    if (managed) await rm(managedSource, { force: true }).catch(() => undefined);
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}
