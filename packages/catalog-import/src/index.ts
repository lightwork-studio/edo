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

export interface CatalogImportInput
  extends Pick<CatalogManifest, "provider" | "schemaVersion" | "importerVersion" | "attribution"> {
  root: string;
  /** A complete, stable input file, such as a downloaded archive. */
  inputPath: string;
  source: Omit<CatalogManifest["source"], "sha256">;
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
    const existing = await fileDigest(destination);
    if (existing.sha256 !== expected.sha256 || existing.bytes !== expected.bytes) {
      throw new Error("Stored catalog file does not match its checksum");
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

/** Serialize writers per provider. Independent providers use separate activation pointers. */
export async function publishCatalog(
  input: CatalogImportInput,
  builder: CatalogBuilder,
): Promise<CatalogManifest> {
  if (!isCatalogProvider(input.provider)) throw new Error("Unknown catalog provider");

  const root = join(input.root, input.provider);
  const artifacts = join(root, "artifacts");
  const releases = join(root, "releases");
  await mkdir(artifacts, { recursive: true });
  await mkdir(releases, { recursive: true });
  // SQLite releases the provider's writer lock even if an import process is terminated.
  using lock = new DatabaseSync(join(root, ".publisher.sqlite"));
  lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  const stage = await mkdtemp(join(root, ".stage-"));
  try {
    const inputFile = await realpath(input.inputPath);
    if (!(await stat(inputFile)).isFile()) throw new Error("Catalog input must be a regular file");
    const stagedSource = join(stage, "source");
    await mkdir(stagedSource);
    const snapshot = join(stagedSource, basename(inputFile));
    await copyFile(inputFile, snapshot, constants.COPYFILE_FICLONE);
    const original = await stat(snapshot, { bigint: true });
    const source = await fileDigest(snapshot);
    const stagedDatabase = join(stage, "catalog.sqlite");
    const counts = await builder.build(snapshot, stagedDatabase);
    await builder.validate(stagedDatabase, counts);
    const final = await stat(snapshot, { bigint: true });
    if (
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
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}
