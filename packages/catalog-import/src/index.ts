import { createHash } from "node:crypto";
import { constants, createReadStream, lstatSync } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type CatalogManifest, isCatalogManifest, isCatalogProvider } from "./manifest.ts";
import {
  archiveCurrentCatalogRelease,
  ensureCatalogReceiptDirectory,
  listPublishedCatalogReleases,
  writeCatalogPublicationReceipt,
} from "./publication-history.ts";

export * from "./manifest.ts";
export { matchesCatalogDatabaseMetadata } from "./metadata.ts";
export { listPublishedCatalogReleases } from "./publication-history.ts";

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
  const path = join(providerRoot, ".publisher.sqlite");
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.nlink !== 1)) {
    throw new Error("Catalog publisher lock must be a regular file with a single link");
  }
  // SQLite releases the provider's writer lock even if an import process is terminated.
  const lock = new DatabaseSync(path);
  try {
    lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    return lock;
  } catch (error) {
    lock.close();
    throw error;
  }
}

async function requireCatalogDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) {
    throw new Error("Catalog paths must be real directories");
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
    await requireCatalogDirectory(providerRoot);
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

async function activateManifest(
  root: string,
  stage: string,
  manifest: CatalogManifest,
  manifestText = `${JSON.stringify(manifest, null, 2)}\n`,
) {
  if (!isCatalogManifest(manifest)) throw new Error("Invalid catalog release manifest");
  await ensureCatalogReceiptDirectory(root);

  const artifacts = join(root, "artifacts");
  const releases = join(root, "releases");
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
  await archiveCurrentCatalogRelease(root, stage, manifest.provider, releaseDigest.sha256);

  const activation = join(stage, "active.json");
  await writeFile(activation, manifestText, { flush: true });
  if (process.platform !== "win32") {
    // Order immutable files and their directory entries before publishing the pointer.
    await Promise.all([syncFile(artifacts), syncFile(releases)]);
    await syncFile(root);
  }
  await rename(activation, join(root, "active.json"));
  try {
    if (process.platform !== "win32") await syncFile(root);
    await writeCatalogPublicationReceipt(root, stage, releaseDigest.sha256);
    if (process.platform !== "win32") await syncFile(root);
  } catch {
    // The pointer rename already committed. It proves the new release until a receipt is written.
  }
}

/** Restore an activated release after rechecking its file and provider compatibility. */
export async function restoreCatalogRelease(
  root: string,
  provider: CatalogManifest["provider"],
  releaseSha256: string,
  validate: (database: DatabaseSync, manifest: CatalogManifest) => void | Promise<void>,
): Promise<CatalogManifest> {
  if (!isCatalogProvider(provider) || !/^[a-f0-9]{64}$/.test(releaseSha256)) {
    throw new Error("Invalid catalog provider or release checksum");
  }
  const providerRoot = join(root, provider);
  const releases = join(providerRoot, "releases");
  const artifacts = join(providerRoot, "artifacts");
  for (const directory of [providerRoot, releases, artifacts]) {
    await requireCatalogDirectory(directory);
  }
  using _lock = lockPublisher(providerRoot);
  if (!(await listPublishedCatalogReleases(root, provider)).includes(releaseSha256)) {
    throw new Error("Catalog restore requires a previously activated release");
  }
  const release = join(releases, `${releaseSha256}.json`);
  if (!(await lstat(release)).isFile()) throw new Error("Catalog release must be a regular file");
  const original = await readFile(release);
  const text = original.toString("utf8");
  if (
    !Buffer.from(text).equals(original) ||
    createHash("sha256").update(original).digest("hex") !== releaseSha256
  ) {
    throw new Error("Stored catalog release does not match its checksum");
  }
  const manifest: unknown = JSON.parse(text);
  if (!isCatalogManifest(manifest) || manifest.provider !== provider) {
    throw new Error("Invalid catalog release manifest");
  }
  const path = join(artifacts, `${manifest.artifact.sha256}.sqlite`);
  const artifact = (await lstat(path)).isFile() ? await fileDigest(path) : null;
  if (artifact?.sha256 !== manifest.artifact.sha256 || artifact.bytes !== manifest.artifact.bytes) {
    throw new Error("Stored catalog artifact does not match its checksum");
  }
  verifyDatabase(path, manifest.schemaVersion);
  using database = new DatabaseSync(path, { readOnly: true });
  if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
    throw new Error("Catalog restore failed SQLite integrity verification");
  }
  await validate(database, manifest);
  const stage = await mkdtemp(join(providerRoot, ".stage-"));
  try {
    await activateManifest(providerRoot, stage, manifest, text);
    return manifest;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Record a source timestamp on the expected active release without rebuilding its database. */
export async function recordCatalogSourceLastModified(
  root: string,
  provider: CatalogManifest["provider"],
  expectedActiveSha256: string,
  lastModified: string,
): Promise<CatalogManifest> {
  if (!isCatalogProvider(provider)) throw new Error("Unknown catalog provider");
  const providerRoot = join(root, provider);
  await requireCatalogDirectory(providerRoot);
  await requireCatalogDirectory(join(providerRoot, "artifacts"));
  await requireCatalogDirectory(join(providerRoot, "releases"));
  using _lock = lockPublisher(providerRoot);
  const active = join(providerRoot, "active.json");
  if (!(await lstat(active)).isFile()) throw new Error("Catalog activation must be a regular file");
  const text = await readFile(active, "utf8");
  const digest = createHash("sha256").update(text).digest("hex");
  if (digest !== expectedActiveSha256)
    throw new Error("Active catalog changed before timestamp update");
  const manifest: unknown = JSON.parse(text);
  if (!isCatalogManifest(manifest) || manifest.provider !== provider) {
    throw new Error("Invalid active catalog manifest");
  }
  const immutable = join(providerRoot, "releases", `${digest}.json`);
  if (!(await lstat(immutable)).isFile() || (await readFile(immutable, "utf8")) !== text) {
    throw new Error("Stored catalog manifest does not match its activation");
  }
  const path = join(providerRoot, "artifacts", `${manifest.artifact.sha256}.sqlite`);
  const artifact = (await lstat(path)).isFile() ? await fileDigest(path) : null;
  if (artifact?.sha256 !== manifest.artifact.sha256 || artifact.bytes !== manifest.artifact.bytes) {
    throw new Error("Stored catalog artifact does not match its checksum");
  }
  verifyDatabase(path, manifest.schemaVersion);

  const next = { ...manifest, source: { ...manifest.source, lastModified } };
  const stage = await mkdtemp(join(providerRoot, ".stage-"));
  try {
    await activateManifest(providerRoot, stage, next);
    return next;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
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
  for (const directory of [root, artifacts, releases]) {
    await mkdir(directory, { recursive: true });
    await requireCatalogDirectory(directory);
  }
  using _lock = lockPublisher(root);
  await ensureCatalogReceiptDirectory(root);
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
    await activateManifest(root, stage, manifest);
    return manifest;
  } finally {
    // Cleanup must preserve the import result and must not mask the underlying failure.
    if (managed) await rm(managedSource, { force: true }).catch(() => undefined);
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}
