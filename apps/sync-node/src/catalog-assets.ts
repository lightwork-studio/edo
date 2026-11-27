import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import {
  type CatalogManifest,
  type CatalogProvider,
  compatibleCatalog,
  listPublishedCatalogReleases,
  matchesCatalogDatabaseMetadata,
} from "@edo/catalog-import";
import { compatibleOpenFoodFactsManifest } from "@edo/off-import";

const blsLicense = "https://creativecommons.org/licenses/by/4.0/";
const blsSource = "https://doi.org/10.25826/Data20251217-134202-0";
export const openFoodFactsAttribution = {
  name: "Open Food Facts contributors",
  license: "https://opendatacommons.org/licenses/odbl/1-0/",
  source: "https://world.openfoodfacts.org/data",
};
const providers = {
  bls: {
    schema: 1,
    origin: blsSource,
    license: `CC BY 4.0 (${blsLicense})`,
    licenseUrl: blsLicense,
    source: blsSource,
  },
  "open-food-facts": {
    licenseUrl: openFoodFactsAttribution.license,
    source: openFoodFactsAttribution.source,
  },
};
const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

type Release = { body: Buffer; manifest: CatalogManifest; digest: string };
type Asset = { provider: CatalogProvider } & (
  | { kind: "active" }
  | { kind: "release" | "artifact"; digest: string }
);

function assetAt(path: string): Asset | null {
  const [, provider, route] = path.match(/^\/catalog-preview\/(bls|open-food-facts)\/(.+)$/) ?? [];
  if ((provider !== "bls" && provider !== "open-food-facts") || !route) return null;
  if (route === "active.json") return { kind: "active", provider };
  const release = route.match(/^releases\/([a-f0-9]{64})\.json$/)?.[1];
  if (release) return { kind: "release", provider, digest: release };
  const artifact = route.match(/^artifacts\/([a-f0-9]{64})\.sqlite$/)?.[1];
  return artifact ? { kind: "artifact", provider, digest: artifact } : null;
}

async function catalogDirectory(
  root: string,
  provider: CatalogProvider,
  child?: "releases" | "artifacts",
) {
  const providerRoot = join(root, provider);
  if (!(await lstat(providerRoot)).isDirectory())
    throw new Error("Invalid catalog provider directory");
  if (!child) return providerRoot;
  const directory = join(providerRoot, child);
  if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid catalog data directory");
  return directory;
}

async function openRegularFile(path: string) {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isFile()) throw new Error("Catalog file must be a regular file");
  const file = await open(path, openFlags);
  try {
    const opened = await file.stat({ bigint: true });
    // A publisher can atomically replace the active manifest before this open.
    const expected =
      opened.ino === entry.ino && opened.dev === entry.dev
        ? entry
        : await lstat(path, { bigint: true });
    if (
      !opened.isFile() ||
      !expected.isFile() ||
      opened.ino !== expected.ino ||
      opened.dev !== expected.dev
    ) {
      throw new Error("Catalog file changed while being opened");
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

function compatibleManifest(value: unknown, provider: CatalogProvider) {
  if (provider === "open-food-facts") return compatibleOpenFoodFactsManifest(value);
  const expected = providers.bls;
  const manifest = compatibleCatalog(value, provider, [expected.schema]);
  return manifest?.source.url === expected.origin &&
    manifest.attribution.license === expected.license
    ? manifest
    : null;
}

async function readRelease(
  root: string,
  provider: CatalogProvider,
  digest?: string,
): Promise<Release> {
  const directory = await catalogDirectory(root, provider, digest ? "releases" : undefined);
  await using file = await openRegularFile(
    join(directory, digest ? `${digest}.json` : "active.json"),
  );
  const stat = await file.stat();
  if (!stat.isFile() || stat.size <= 0 || (provider === "bls" && stat.size > 16 * 1024)) {
    throw new Error("Invalid catalog manifest size or type");
  }
  const buffer = Buffer.alloc(stat.size + 1);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  if (bytesRead !== stat.size) throw new Error("Catalog manifest changed while being read");
  const body = buffer.subarray(0, bytesRead);
  const actual = createHash("sha256").update(body).digest("hex");
  if (digest && actual !== digest) throw new Error("Catalog release checksum mismatch");
  const text = body.toString("utf8");
  if (!Buffer.from(text).equals(body)) throw new Error("Invalid catalog manifest UTF-8");
  const manifest = compatibleManifest(JSON.parse(text), provider);
  if (!manifest) throw new Error("Unsupported catalog release");
  return { body, manifest, digest: actual };
}

async function resolveReleases(
  root: string,
  asset: Asset,
  servedOffRelease?: string,
): Promise<Release[]> {
  const { provider } = asset;
  if (asset.kind === "active") {
    const active = await readRelease(root, provider);
    const immutable = await readRelease(root, provider, active.digest);
    if (!immutable.body.equals(active.body))
      throw new Error("Catalog activation differs from its release");
    return [active];
  }
  const published = new Set(await listPublishedCatalogReleases(root, provider));
  // A running reader can still serve a verified catalog whose legacy pointer was damaged.
  if (provider === "open-food-facts" && servedOffRelease) published.add(servedOffRelease);
  if (asset.kind === "release") {
    return published.has(asset.digest) ? [await readRelease(root, provider, asset.digest)] : [];
  }
  const matches: Release[] = [];
  for (const release of published) {
    const known = await readRelease(root, provider, release).catch(() => null);
    if (known?.manifest.artifact.sha256 === asset.digest) matches.push(known);
  }
  return matches;
}

async function snapshotArtifact(
  root: string,
  provider: CatalogProvider,
  digest: string,
  releases: Release[],
  destination: string,
): Promise<Release> {
  const directory = await catalogDirectory(root, provider, "artifacts");
  await using file = await openRegularFile(join(directory, `${digest}.sqlite`));
  const stat = await file.stat();
  const candidates = releases.filter(({ manifest }) => manifest.artifact.bytes === stat.size);
  if (!stat.isFile() || !candidates.length)
    throw new Error("Invalid catalog artifact size or type");

  let bytes = 0;
  const hash = createHash("sha256");
  await pipeline(
    file.createReadStream({ autoClose: false, start: 0 }),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        bytes += chunk.length;
        if (bytes > stat.size) throw new Error("Catalog artifact grew while being read");
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  if (bytes !== stat.size || hash.digest("hex") !== digest) {
    throw new Error("Catalog artifact checksum mismatch");
  }
  using database = new DatabaseSync(destination, { readOnly: true });
  if (
    database.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete" ||
    (provider === "bls" &&
      database.prepare("SELECT singleton FROM catalog_metadata").get()?.singleton !== 1)
  ) {
    throw new Error("Catalog artifact has incompatible SQLite metadata");
  }
  const matched = candidates.find(({ manifest }) =>
    matchesCatalogDatabaseMetadata(database, manifest, providers[provider].licenseUrl),
  );
  if (!matched) {
    throw new Error("Catalog artifact metadata does not match its manifest");
  }
  return matched;
}

function etagMatches(header: string | undefined, etag: string | undefined): boolean {
  const value = header?.trim() ?? "";
  return (
    value === "*" ||
    (etag !== undefined &&
      [...value.matchAll(/(?:^|,)\s*(?:W\/)?("[^"]*")(?=\s*(?:,|$))/g)].some(
        ([, tag]) => tag === etag,
      ))
  );
}

/** Offer verified public catalog files through the loopback development server. */
export async function serveCatalogAssets(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  servedOffRelease?: string,
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const asset = assetAt(request.url?.split("?", 1)[0] ?? "");
  if (!asset) return false;

  const { provider } = asset;
  const { licenseUrl, source } = providers[provider];
  const etag = asset.kind === "active" ? undefined : `"${asset.digest}"`;
  const notModified = etagMatches(request.headers["if-none-match"], etag);
  const headers = {
    "Content-Type": asset.kind === "artifact" ? "application/vnd.sqlite3" : "application/json",
    "Cache-Control": etag ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    Link: `<${licenseUrl}>; rel="license", <${source}>; rel="cite-as"`,
    ...(etag && { ETag: etag }),
  };
  let scratch: string | undefined;
  try {
    const releases = await resolveReleases(root, asset, servedOffRelease);
    let [release] = releases;
    if (!release) {
      response.writeHead(404).end();
      return true;
    }

    let snapshot: string | undefined;
    if (asset.kind !== "release") {
      scratch = await mkdtemp(join(tmpdir(), "edo-catalog-preview-"));
      snapshot = join(scratch, "catalog.sqlite");
      release = await snapshotArtifact(
        root,
        provider,
        release.manifest.artifact.sha256,
        releases,
        snapshot,
      );
    }
    if (notModified) {
      response.writeHead(304, headers).end();
    } else if (asset.kind === "artifact" && snapshot) {
      response.writeHead(200, { ...headers, "Content-Length": release.manifest.artifact.bytes });
      if (request.method === "GET") await pipeline(createReadStream(snapshot), response);
      else response.end();
    } else {
      response
        .writeHead(200, { ...headers, "Content-Length": release.body.length })
        .end(request.method === "GET" ? release.body : undefined);
    }
  } catch (error) {
    if (response.headersSent) response.destroy();
    else {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      response.writeHead(code === "ENOENT" && asset.kind !== "active" ? 404 : 503).end();
    }
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
  return true;
}
