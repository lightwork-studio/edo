import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { validateBlsCatalogRelease } from "../../packages/bls-import/src/publish.ts";
import {
  type CatalogManifest,
  type CatalogProvider,
  compatibleCatalog,
} from "../../packages/catalog-import/src/manifest.ts";
import { barcodeRows, readProduct } from "../../packages/off-import/src/catalog-row.ts";
import { validateCatalogSnapshot } from "../../packages/off-import/src/catalog-snapshot.ts";
import { refreshOpenFoodFactsDeltas } from "../../packages/off-import/src/delta.ts";
import { compatibleOpenFoodFactsManifest } from "../../packages/off-import/src/publish.ts";
import {
  type CatalogState,
  checksum,
  maxBlsArtifactBytes,
  maxBlsManifestBytes,
  maxManifestBytes,
  maxOffSourceAgeMilliseconds,
  maxStateBytes,
  readCatalogState,
} from "./state.ts";
import { shardFor } from "./worker.ts";

const exec = promisify(execFile);
const bucket = "edo-catalogs";
const off = "open-food-facts";
const notFound = /\(404\)|\(NoSuchKey\)/;
const alreadyExists = /\(412\)|\(PreconditionFailed\)/;
const decoder = new TextDecoder("utf-8", { fatal: true });

function manifestFrom(raw: Buffer, provider: CatalogProvider) {
  const value: unknown = JSON.parse(decoder.decode(raw));
  const manifest =
    provider === off
      ? compatibleOpenFoodFactsManifest(value)
      : compatibleCatalog(value, provider, [1]);
  if (!manifest) throw new Error("Unsupported catalog release");
  return manifest;
}

function digest(raw: Buffer | string) {
  return createHash("sha256").update(raw).digest("hex");
}

async function fileDigest(path: string) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), bytes };
}

function profile(account: string | undefined) {
  if (!account || !/^[a-f0-9]{32}$/.test(account))
    throw new Error("Missing or invalid EDO_R2_ACCOUNT_ID");
  const endpoint = `https://${account}.r2.cloudflarestorage.com`;
  return async (operation: string, key: string, ...args: string[]) => {
    const { stdout } = await exec(
      "aws",
      [
        "s3api",
        operation,
        "--region",
        "auto",
        "--endpoint-url",
        endpoint,
        "--bucket",
        bucket,
        "--key",
        key,
        "--no-cli-pager",
        "--output",
        "json",
        ...args,
      ],
      {
        timeout: 180_000,
        env: {
          ...process.env,
          AWS_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED",
          AWS_RESPONSE_CHECKSUM_VALIDATION: "WHEN_REQUIRED",
        },
      },
    );
    return JSON.parse(stdout) as { ETag?: string };
  };
}

type R2 = ReturnType<typeof profile>;

function hasStatus(error: unknown, status: RegExp) {
  return error instanceof Error && "stderr" in error && status.test(String(error.stderr));
}

async function downloadState(r2: R2, provider: CatalogProvider, directory: string) {
  const path = join(directory, "state.json");
  let result: Awaited<ReturnType<R2>>;
  try {
    result = await r2("get-object", `${provider}/state.json`, path);
  } catch (error) {
    if (hasStatus(error, notFound)) return null;
    throw error;
  }
  const etag = result.ETag;
  if (!etag || !/^"[^"\r\n]+"$/.test(etag)) throw new Error("Missing catalog state ETag");
  const rawState = await readFile(path);
  if (rawState.length > maxStateBytes) throw new Error("Published catalog state is oversized");
  return { etag, state: readCatalogState(JSON.parse(decoder.decode(rawState))) };
}

async function downloadActive(r2: R2, provider: CatalogProvider, directory: string) {
  const publication = await downloadState(r2, provider, directory);
  if (!publication) return null;
  const { state } = publication;
  const active = join(directory, "remote-active.json");
  await r2("get-object", `${provider}/releases/${state.active}.json`, active);
  const raw = await readFile(active);
  if (
    raw.length > (provider === "bls" ? maxBlsManifestBytes : maxManifestBytes) ||
    digest(raw) !== state.active
  ) {
    throw new Error("Published manifest does not match the active digest");
  }
  const manifest = manifestFrom(raw, provider);
  if (manifest.artifact.sha256 !== state.releases[state.active]) {
    throw new Error("Published manifest does not match the active artifact");
  }
  return { raw, hash: state.active, manifest, ...publication };
}

async function verifyFile(path: string, expected: { sha256: string; bytes?: number }) {
  const file = await fileDigest(path);
  if (
    file.sha256 !== expected.sha256 ||
    (expected.bytes !== undefined && file.bytes !== expected.bytes)
  ) {
    throw new Error("Catalog object failed checksum verification");
  }
}

async function publishImmutable(r2: R2, key: string, path: string, scratch: string) {
  const expected = await fileDigest(path);
  const verification = join(scratch, `verify-${digest(key)}`);
  try {
    await r2("put-object", key, "--if-none-match", "*", "--body", path);
  } catch (error) {
    if (!hasStatus(error, alreadyExists)) throw error;
  }
  try {
    await r2("get-object", key, verification);
    await verifyFile(verification, expected);
  } finally {
    await rm(verification, { force: true });
  }
}

async function lookupFiles(
  path: string,
  manifest: CatalogManifest,
  releaseHash: string,
  scratch: string,
) {
  const shards = new Map<string, Map<string, Omit<ReturnType<typeof readProduct>, "release">[]>>();
  using database = new DatabaseSync(path, { readOnly: true });
  for (const row of database.prepare(`${barcodeRows} ORDER BY food.source_id`).iterate()) {
    if (typeof row.lookup_code !== "string") throw new Error("Invalid catalog barcode index");
    const key = row.lookup_code;
    const prefix = shardFor(key);
    let shard = shards.get(prefix);
    if (!shard) {
      shard = new Map();
      shards.set(prefix, shard);
    }
    const matches = shard.get(key) ?? [];
    const { release: _release, ...product } = readProduct(row, manifest.source.release);
    matches.push(product);
    shard.set(key, matches);
  }
  const files: { key: string; path: string }[] = [];
  const index: Record<string, string> = {};
  for (const [prefix, shard] of shards) {
    const body = JSON.stringify(Object.fromEntries(shard));
    if (Buffer.byteLength(body) > 8 * 1024 * 1024)
      throw new Error("Catalog barcode shard is oversized");
    const hash = digest(body);
    const file = join(scratch, `shard-${hash}.json`);
    await writeFile(file, body);
    index[prefix] = hash;
    files.push({ key: `${off}/shards/${hash}.json`, path: file });
  }
  const indexFile = join(scratch, "lookup.json");
  const indexBody = JSON.stringify(index);
  await writeFile(indexFile, indexBody);
  return {
    files,
    index: {
      key: `${off}/lookup/${releaseHash}.json`,
      path: indexFile,
      sha256: digest(indexBody),
    },
  };
}

export async function publishCatalogToR2(
  r2: R2,
  root: string,
  provider: CatalogProvider,
  current: { etag: string; state: CatalogState } | undefined,
  scratch: string,
  reviewedArtifact?: string,
) {
  const base = join(root, provider);
  const active = join(base, "active.json");
  const raw = await readFile(active);
  if (raw.length > (provider === "bls" ? maxBlsManifestBytes : maxManifestBytes)) {
    throw new Error("Catalog manifest is oversized");
  }
  const manifest = manifestFrom(raw, provider);
  if (provider === "bls" && manifest.artifact.bytes > maxBlsArtifactBytes) {
    throw new Error("BLS catalog artifact exceeds the mobile download limit");
  }
  if (provider === "bls" && manifest.artifact.sha256 !== reviewedArtifact) {
    throw new Error("BLS catalog artifact does not match the reviewed checksum");
  }
  const releaseHash = digest(raw);
  const artifact = join(base, "artifacts", `${manifest.artifact.sha256}.sqlite`);
  const release = join(base, "releases", `${releaseHash}.json`);
  await verifyFile(artifact, manifest.artifact);
  await verifyFile(release, { sha256: releaseHash });
  let barcodeIndex: string | undefined;
  if (provider === off) {
    await validateCatalogSnapshot(artifact, manifest);
    const lookup = await lookupFiles(artifact, manifest, releaseHash, scratch);
    for (let offset = 0; offset < lookup.files.length; offset += 8) {
      await Promise.all(
        lookup.files
          .slice(offset, offset + 8)
          .map((file) => publishImmutable(r2, file.key, file.path, scratch)),
      );
    }
    await publishImmutable(r2, lookup.index.key, lookup.index.path, scratch);
    barcodeIndex = lookup.index.sha256;
    if (manifest.source.url === "https://static.openfoodfacts.org/data/delta/index.txt") {
      const key = `delta-sources/${manifest.source.sha256}.json`;
      const receipt = join(base, key);
      await verifyFile(receipt, { sha256: manifest.source.sha256 });
      await publishImmutable(r2, `${provider}/${key}`, receipt, scratch);
    }
  } else {
    await validateBlsCatalogRelease(artifact, manifest);
  }
  await publishImmutable(
    r2,
    `${provider}/artifacts/${manifest.artifact.sha256}.sqlite`,
    artifact,
    scratch,
  );
  await publishImmutable(r2, `${provider}/releases/${releaseHash}.json`, release, scratch);
  const state: CatalogState = {
    active: releaseHash,
    releases: { ...current?.state.releases, [releaseHash]: manifest.artifact.sha256 },
    ...(barcodeIndex && {
      barcodeIndexes: { ...current?.state.barcodeIndexes, [releaseHash]: barcodeIndex },
    }),
  };
  const stateText = JSON.stringify(state);
  if (Buffer.byteLength(stateText) > maxStateBytes)
    throw new Error("Catalog publication state is oversized");
  const statePath = join(scratch, "next-state.json");
  await writeFile(statePath, stateText);
  const condition = current ? ["--if-match", current.etag] : ["--if-none-match", "*"];
  await r2("put-object", `${provider}/state.json`, ...condition, "--body", statePath);
  return releaseHash;
}

async function run() {
  const r2 = profile(process.env.EDO_R2_ACCOUNT_ID);
  const scratch = await mkdtemp(join(tmpdir(), "edo-r2-"));
  try {
    const [mode, provider, root, expected, reviewedArtifact, ...extra] = process.argv.slice(2);
    if (mode === "nightly" && provider === undefined) {
      const current = await downloadActive(r2, off, scratch);
      if (!current) throw new Error("Seed Open Food Facts in R2 before enabling refresh");
      const localRoot = join(scratch, "catalogs");
      const base = join(localRoot, off);
      await Promise.all(
        ["artifacts", "releases"].map((dir) => mkdir(join(base, dir), { recursive: true })),
      );
      const artifactKey = `artifacts/${current.manifest.artifact.sha256}.sqlite`;
      const releaseKey = `releases/${current.hash}.json`;
      await Promise.all(
        [artifactKey, releaseKey].map((key) => r2("get-object", `${off}/${key}`, join(base, key))),
      );
      await writeFile(join(base, "active.json"), current.raw);
      const result = await refreshOpenFoodFactsDeltas(localRoot);
      const time = Date.parse(result.manifest.source.lastModified ?? "");
      if (!(Date.now() - time < maxOffSourceAgeMilliseconds))
        throw new Error("Open Food Facts catalog source is more than 72 hours old");
      const release =
        result.status === "published"
          ? await publishCatalogToR2(r2, localRoot, off, current, scratch)
          : current.hash;
      console.log(
        JSON.stringify({
          status: result.status,
          release,
          cursor: result.cursor,
          rows: result.manifest.counts.accepted,
        }),
      );
    } else if (
      mode === "publish" &&
      (provider === "bls" || provider === off) &&
      root &&
      expected &&
      (expected === "empty" || checksum.test(expected)) &&
      (provider === off
        ? reviewedArtifact === undefined
        : reviewedArtifact && checksum.test(reviewedArtifact)) &&
      extra.length === 0
    ) {
      const current = await downloadState(r2, provider, scratch);
      if ((current?.state.active ?? "empty") !== expected)
        throw new Error("Active R2 catalog changed before publication");
      console.log(
        await publishCatalogToR2(
          r2,
          root,
          provider,
          current ?? undefined,
          scratch,
          reviewedArtifact,
        ),
      );
    } else {
      throw new Error(
        "Usage: publish.ts nightly | publish <provider> <catalog-root> <empty|active-sha256> [reviewed-BLS-artifact-sha256]",
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) await run();
