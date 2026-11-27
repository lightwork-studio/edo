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
  compatibleCatalog,
  listPublishedCatalogReleases,
} from "@edo/catalog-import";

const prefix = "/catalog-preview/bls";
const license = "https://creativecommons.org/licenses/by/4.0/";
const sourceUrl = "https://doi.org/10.25826/Data20251217-134202-0";
const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

type Release = { body: Buffer; manifest: CatalogManifest; digest: string };
type Asset = { kind: "active" } | { kind: "release" | "artifact"; digest: string };

function assetAt(path: string): Asset | null {
  if (!path.startsWith(`${prefix}/`)) return null;
  const route = path.slice(prefix.length + 1);
  if (route === "active.json") return { kind: "active" };
  const release = route.match(/^releases\/([a-f0-9]{64})\.json$/)?.[1];
  if (release) return { kind: "release", digest: release };
  const artifact = route.match(/^artifacts\/([a-f0-9]{64})\.sqlite$/)?.[1];
  return artifact ? { kind: "artifact", digest: artifact } : null;
}

async function catalogDirectory(root: string, child?: "releases" | "artifacts") {
  const provider = join(root, "bls");
  if (!(await lstat(provider)).isDirectory()) throw new Error("Invalid BLS provider directory");
  if (!child) return provider;
  const directory = join(provider, child);
  if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid BLS data directory");
  return directory;
}

async function readRelease(root: string, digest?: string): Promise<Release> {
  const directory = await catalogDirectory(root, digest ? "releases" : undefined);
  await using file = await open(
    join(directory, digest ? `${digest}.json` : "active.json"),
    openFlags,
  );
  const stat = await file.stat();
  if (!stat.isFile() || stat.size <= 0 || stat.size > 16 * 1024) {
    throw new Error("Invalid BLS manifest size or type");
  }
  const buffer = Buffer.alloc(stat.size + 1);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  if (bytesRead !== stat.size) throw new Error("BLS manifest changed while being read");
  const body = buffer.subarray(0, bytesRead);
  const actual = createHash("sha256").update(body).digest("hex");
  if (digest && actual !== digest) throw new Error("BLS release checksum mismatch");
  const text = body.toString("utf8");
  if (!Buffer.from(text).equals(body)) throw new Error("Invalid BLS manifest UTF-8");
  const manifest = compatibleCatalog(JSON.parse(text), "bls", [1]);
  if (
    manifest?.source.url !== sourceUrl ||
    manifest.attribution.license !== `CC BY 4.0 (${license})`
  ) {
    throw new Error("Unsupported BLS release");
  }
  return { body, manifest, digest: actual };
}

async function findPublishedArtifact(root: string, digest: string): Promise<Release | null> {
  for (const release of await listPublishedCatalogReleases(root, "bls")) {
    const known = await readRelease(root, release).catch(() => null);
    if (known?.manifest.artifact.sha256 === digest) return known;
  }
  return null;
}

async function snapshotArtifact(root: string, manifest: CatalogManifest, destination: string) {
  const { artifact } = manifest;
  const directory = await catalogDirectory(root, "artifacts");
  await using file = await open(join(directory, `${artifact.sha256}.sqlite`), openFlags);
  const stat = await file.stat();
  if (!stat.isFile() || stat.size !== artifact.bytes)
    throw new Error("Invalid BLS artifact size or type");

  let bytes = 0;
  const hash = createHash("sha256");
  await pipeline(
    file.createReadStream({ autoClose: false, start: 0 }),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        bytes += chunk.length;
        if (bytes > artifact.bytes) throw new Error("BLS artifact grew while being read");
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  if (bytes !== artifact.bytes || hash.digest("hex") !== artifact.sha256) {
    throw new Error("BLS artifact checksum mismatch");
  }
  using database = new DatabaseSync(destination, { readOnly: true });
  const metadata = database
    .prepare(
      "SELECT provider, release, source_url, attribution, license_url, changes FROM catalog_metadata WHERE singleton = 1",
    )
    .get();
  if (
    database.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete" ||
    database.prepare("PRAGMA user_version").get()?.user_version !== manifest.schemaVersion ||
    metadata?.provider !== manifest.provider ||
    metadata.release !== manifest.source.release ||
    metadata.source_url !== manifest.source.url ||
    metadata.attribution !== manifest.attribution.name ||
    metadata.changes !== manifest.attribution.changes ||
    metadata.license_url !== license
  ) {
    throw new Error("BLS artifact metadata does not match its manifest");
  }
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

/** Offer verified, published BLS files through the loopback development server. */
export async function serveBlsPreview(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const asset = assetAt(request.url?.split("?", 1)[0] ?? "");
  if (!asset) return false;

  const etag = asset.kind === "active" ? undefined : `"${asset.digest}"`;
  const notModified = etagMatches(request.headers["if-none-match"], etag);
  const headers = {
    "Content-Type": asset.kind === "artifact" ? "application/vnd.sqlite3" : "application/json",
    "Cache-Control": etag ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    Link: `<${license}>; rel="license", <${sourceUrl}>; rel="cite-as"`,
    ...(etag && { ETag: etag }),
  };
  let scratch: string | undefined;
  try {
    let release: Release | null;
    if (asset.kind === "active") {
      release = await readRelease(root);
      const immutable = await readRelease(root, release.digest);
      if (!immutable.body.equals(release.body))
        throw new Error("BLS activation differs from its release");
    } else if (asset.kind === "release") {
      const published = await listPublishedCatalogReleases(root, "bls");
      release = published.includes(asset.digest) ? await readRelease(root, asset.digest) : null;
    } else {
      release = await findPublishedArtifact(root, asset.digest);
    }
    if (!release) {
      response.writeHead(404).end();
      return true;
    }

    let snapshot: string | undefined;
    if (asset.kind !== "release") {
      scratch = await mkdtemp(join(tmpdir(), "edo-bls-preview-"));
      snapshot = join(scratch, "catalog.sqlite");
      await snapshotArtifact(root, release.manifest, snapshot);
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
