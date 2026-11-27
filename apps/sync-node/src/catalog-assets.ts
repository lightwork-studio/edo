import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type CatalogManifest,
  type CatalogProvider,
  compatibleCatalog,
  requireCatalogDirectory,
} from "@edo/catalog-import";
import { compatibleOpenFoodFactsManifest } from "@edo/off-import";

export const offLicense = "https://opendatacommons.org/licenses/odbl/1-0/";
const blsLicense = "https://creativecommons.org/licenses/by/4.0/";
const blsSource = "https://doi.org/10.25826/Data20251217-134202-0";
const catalogLinks = {
  bls: `<${blsLicense}>; rel="license", <${blsSource}>; rel="cite-as"`,
  "open-food-facts": `<${offLicense}>; rel="license"`,
};
const manifestLimit = 16 * 1024;
const assetOpenFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

type Asset = { readonly provider: CatalogProvider } & (
  | { readonly kind: "active" }
  | { readonly kind: "release" | "artifact"; readonly digest: string }
);

function assetAt(path: string): Asset | null {
  const route = path.match(/^\/catalog-preview\/(bls|open-food-facts)\/(.+)$/);
  if (!route) return null;
  const [, provider, relative] = route;
  if ((provider !== "bls" && provider !== "open-food-facts") || !relative) return null;
  if (relative === "active.json") return { provider, kind: "active" };

  const release = relative.match(/^releases\/([a-f0-9]{64})\.json$/)?.[1];
  if (release) return { provider, kind: "release", digest: release };
  const artifact = relative.match(/^artifacts\/([a-f0-9]{64})\.sqlite$/)?.[1];
  return artifact ? { provider, kind: "artifact", digest: artifact } : null;
}

function catalogDirectory(
  root: string,
  provider: CatalogProvider,
  folder?: "releases" | "artifacts",
) {
  const directory = join(root, provider);
  requireCatalogDirectory(directory);
  if (!folder) return directory;
  const child = join(directory, folder);
  requireCatalogDirectory(child);
  return child;
}

function manifestFor(value: unknown, provider: CatalogProvider) {
  if (provider === "open-food-facts") return compatibleOpenFoodFactsManifest(value);
  const manifest = compatibleCatalog(value, provider, [1]);
  return manifest?.source.url === blsSource &&
    manifest.attribution.license === `CC BY 4.0 (${blsLicense})`
    ? manifest
    : null;
}

async function readManifest(root: string, provider: CatalogProvider, digest?: string) {
  const directory = catalogDirectory(root, provider, digest ? "releases" : undefined);
  await using file = await open(
    join(directory, digest ? `${digest}.json` : "active.json"),
    assetOpenFlags,
  );
  const metadata = await file.stat();
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > manifestLimit) {
    throw new Error("Invalid catalog manifest size or type");
  }
  const buffer = Buffer.alloc(metadata.size + 1);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  if (bytesRead !== metadata.size) throw new Error("Catalog manifest changed while being read");
  const body = buffer.subarray(0, bytesRead);
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (digest && sha256 !== digest) throw new Error("Catalog release checksum mismatch");
  const manifest = manifestFor(JSON.parse(body.toString("utf8")), provider);
  if (!manifest) throw new Error("Unsupported catalog provider or attribution");
  return { body, manifest, sha256 };
}

async function readActiveManifest(root: string, provider: CatalogProvider) {
  const active = await readManifest(root, provider);
  try {
    const published = await readManifest(root, provider, active.sha256);
    if (!published.body.equals(active.body))
      throw new Error("Catalog activation differs from its release");
    await verifyArtifact(root, provider, active.manifest.artifact);
  } catch (error) {
    throw new Error("No verified catalog activation", { cause: error });
  }
  return active.body;
}

async function publishedArtifact(root: string, provider: CatalogProvider, digest: string) {
  const releases = await readdir(catalogDirectory(root, provider, "releases"));
  for (const filename of releases) {
    const release = filename.match(/^([a-f0-9]{64})\.json$/)?.[1];
    if (!release) continue;
    const published = await readManifest(root, provider, release).catch(() => null);
    if (published?.manifest.artifact.sha256 === digest) return published.manifest.artifact;
  }
  return null;
}

async function verifyArtifact(
  root: string,
  provider: CatalogProvider,
  artifact: CatalogManifest["artifact"],
  snapshot?: string,
) {
  const directory = catalogDirectory(root, provider, "artifacts");
  await using file = await open(join(directory, `${artifact.sha256}.sqlite`), assetOpenFlags);
  const metadata = await file.stat();
  if (!metadata.isFile() || metadata.size !== artifact.bytes)
    throw new Error("Invalid catalog artifact size or type");
  const hash = createHash("sha256");
  let bytes = 0;
  const source = file.createReadStream({ autoClose: false, start: 0 });
  const destination = snapshot
    ? createWriteStream(snapshot, { flags: "wx", mode: 0o600 })
    : new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });
  await pipeline(
    source,
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        bytes += chunk.length;
        if (bytes > artifact.bytes) throw new Error("Catalog artifact grew while being read");
        hash.update(chunk);
        yield chunk;
      }
    },
    destination,
  );
  if (bytes !== artifact.bytes || hash.digest("hex") !== artifact.sha256) {
    throw new Error("Catalog artifact checksum mismatch");
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

export async function serveCatalogAsset(
  root: string,
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const asset = assetAt(path);
  if (!asset) return false;
  const etag = asset.kind === "active" ? undefined : `"${asset.digest}"`;
  const notModified = etagMatches(request.headers["if-none-match"], etag);
  const headers = {
    "Content-Type": asset.kind === "artifact" ? "application/vnd.sqlite3" : "application/json",
    "Cache-Control": etag ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    Link: catalogLinks[asset.provider],
    ...(etag && { ETag: etag }),
  };
  let scratch: string | undefined;
  try {
    if (asset.kind !== "artifact") {
      const body =
        asset.kind === "active"
          ? await readActiveManifest(root, asset.provider)
          : (await readManifest(root, asset.provider, asset.digest)).body;
      if (notModified) response.writeHead(304, headers).end();
      else
        response
          .writeHead(200, { ...headers, "Content-Length": body.length })
          .end(request.method === "HEAD" ? undefined : body);
      return true;
    }

    const artifact = await publishedArtifact(root, asset.provider, asset.digest);
    if (!artifact) {
      response.writeHead(404).end();
      return true;
    }
    const sendBody = request.method === "GET" && !notModified;
    scratch = sendBody ? await mkdtemp(join(tmpdir(), "edo-catalog-response-")) : undefined;
    const snapshot = scratch && join(scratch, "catalog.sqlite");
    await verifyArtifact(root, asset.provider, artifact, snapshot);
    if (notModified) response.writeHead(304, headers).end();
    else {
      response.writeHead(200, { ...headers, "Content-Length": artifact.bytes });
      if (snapshot) await pipeline(createReadStream(snapshot), response);
      else response.end();
    }
  } catch (error) {
    if (response.headersSent) response.destroy();
    else {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      response.writeHead(code === "ENOENT" || code === "ELOOP" ? 404 : 503).end();
    }
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
  return true;
}
