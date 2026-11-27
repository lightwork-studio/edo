import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import {
  type CatalogManifest,
  clearPreparedCatalogSource,
  recordCatalogSourceLastModified,
} from "@edo/catalog-import";
import {
  compatibleOpenFoodFactsManifest,
  matchesOpenFoodFactsDatabase,
  openFoodFactsCatalog,
  publishOpenFoodFactsRelease,
} from "./publish.ts";
import { runCatalogJob } from "./worker.ts";

const { provider, importerVersion, sourceUrl } = openFoodFactsCatalog;
const requestHeaders = {
  "Accept-Encoding": "identity",
  "User-Agent": "Edo/1 (https://github.com/lightwork-studio/edo)",
};
const redirectStatusCodes = new Set([301, 302, 303, 307, 308]);
const downloadIdleSeconds = 60;

type FetchExport = (url: string, init: RequestInit) => Promise<Response>;

interface UpstreamExport {
  bytes: number;
  release: string;
  lastModified: string | undefined;
  precondition: Record<string, string>;
}

interface ActiveRelease {
  manifest: CatalogManifest;
  activatedAt: string;
}

export interface RefreshResult extends ActiveRelease {
  status: "published" | "unchanged";
  checkedAt: string;
}

async function fetchHttps(url: string, init: RequestInit): Promise<Response> {
  let target = new URL(url);
  for (let redirects = 0; redirects <= 20; redirects++) {
    if (target.protocol !== "https:" || target.username || target.password) {
      throw new Error("Open Food Facts export requires HTTPS without URL credentials");
    }
    const response = await fetch(target, { ...init, redirect: "manual" });
    if (!redirectStatusCodes.has(response.status)) return response;

    await response.body?.cancel();
    const location = response.headers.get("location");
    const next = location && URL.parse(location, target.href);
    if (!next) throw new Error("Open Food Facts export returned an invalid redirect");
    target = next;
  }
  throw new Error("Open Food Facts export returned too many redirects");
}

function readMetadata(response: Response): UpstreamExport {
  if (response.status !== 200) {
    throw new Error(`Open Food Facts export returned HTTP ${response.status}`);
  }
  const headers = response.headers;
  const encoding = headers.get("content-encoding")?.toLowerCase();
  const length = headers.get("content-length");
  const bytes = Number(length);
  if (
    headers.has("content-range") ||
    (encoding && encoding !== "identity") ||
    !length ||
    !/^\d+$/.test(length) ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0
  ) {
    throw new Error("Open Food Facts export must be a complete, unencoded gzip file of known size");
  }

  const modified = headers.get("last-modified");
  const modifiedAt = Date.parse(modified ?? "");
  const lastModified = Number.isFinite(modifiedAt) ? new Date(modifiedAt).toISOString() : undefined;
  const headerTag = headers.get("etag");
  const etag = headerTag && /^(W\/)?"[^"\s]*"$/.test(headerTag) ? headerTag : null;
  const resource = URL.parse(response.url);
  if (!resource) throw new Error("Open Food Facts export is missing its response URL");
  resource.hash = "";
  // Validators are scoped to the effective resource. Keep redirect URLs out of release metadata.
  const resourceDigest = createHash("sha256").update(resource.href).digest("hex");
  if (etag && !etag.startsWith("W/")) {
    return {
      bytes,
      release: `${resourceDigest}:etag:${etag}:${bytes}`,
      lastModified,
      precondition: { "If-Match": etag },
    };
  }
  if (modified && lastModified) {
    return {
      bytes,
      release: `${resourceDigest}:last-modified:${lastModified}:${bytes}${etag ? `:${etag}` : ""}`,
      lastModified,
      precondition: { "If-Unmodified-Since": modified },
    };
  }
  throw new Error("Open Food Facts export has no strong ETag or Last-Modified timestamp");
}

async function checkUpstream(fetchExport: FetchExport): Promise<UpstreamExport> {
  return readMetadata(
    await fetchExport(sourceUrl, {
      method: "HEAD",
      headers: requestHeaders,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    }),
  );
}

function verifySource(expected: UpstreamExport, received: UpstreamExport): void {
  if (received.release !== expected.release) {
    throw new Error("Open Food Facts export changed during refresh");
  }
}

async function downloadExport(
  expected: UpstreamExport,
  inputPath: string,
  fetchExport: FetchExport,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), downloadIdleSeconds * 1000);
  let response: Response | undefined;
  try {
    response = await fetchExport(sourceUrl, {
      method: "GET",
      headers: { ...requestHeaders, ...expected.precondition },
      cache: "no-store",
      signal: controller.signal,
    });
    timeout.refresh();
    if (response.status === 412) throw new Error("Open Food Facts export changed before download");
    verifySource(expected, readMetadata(response));
    if (!response.body) throw new Error("Open Food Facts export has no download body");
    controller.signal.throwIfAborted();
    // Open the file before starting the pipeline so publisher cleanup cannot race a pending open.
    await using output = await open(inputPath, "wx", 0o600);
    controller.signal.throwIfAborted();
    await pipeline(
      response.body,
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          if (chunk.byteLength > 0) timeout.refresh();
          yield chunk;
        }
      },
      output.createWriteStream(),
      { signal: controller.signal },
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Open Food Facts download stalled for ${downloadIdleSeconds} seconds`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    await response?.body?.cancel().catch(() => undefined);
  }

  if ((await stat(inputPath)).size !== expected.bytes) {
    throw new Error("Open Food Facts download length does not match upstream metadata");
  }
}

function missingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readActiveRelease(
  providerRoot: string,
): Promise<(ActiveRelease & { sha256: string }) | null> {
  try {
    const activePath = join(providerRoot, "active.json");
    const entry = await lstat(activePath);
    if (entry.isSymbolicLink()) return null;
    if (!entry.isFile()) throw new Error("Open Food Facts active.json must be a regular file");

    await using active = await open(activePath, "r");
    const manifestText = await active.readFile("utf8");
    const manifest = compatibleOpenFoodFactsManifest(JSON.parse(manifestText));
    if (!manifest) return null;

    const manifestDigest = createHash("sha256").update(manifestText).digest("hex");
    const immutableManifest = join(providerRoot, "releases", `${manifestDigest}.json`);
    if (!(await lstat(immutableManifest)).isFile()) return null;
    if ((await readFile(immutableManifest, "utf8")) !== manifestText) return null;

    return {
      manifest,
      activatedAt: (await active.stat()).mtime.toISOString(),
      sha256: manifestDigest,
    };
  } catch (error) {
    if (error instanceof SyntaxError || missingFile(error)) return null;
    throw error;
  }
}

async function verifyActiveArtifact(
  providerRoot: string,
  manifest: CatalogManifest,
): Promise<boolean> {
  try {
    const artifact = join(providerRoot, "artifacts", `${manifest.artifact.sha256}.sqlite`);
    const artifactStat = await lstat(artifact);
    if (!artifactStat.isFile() || artifactStat.size !== manifest.artifact.bytes) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(artifact)) hash.update(chunk);
    if (hash.digest("hex") !== manifest.artifact.sha256) return false;
    using database = new DatabaseSync(artifact, { readOnly: true });
    return matchesOpenFoodFactsDatabase(database, manifest);
  } catch (error) {
    if (missingFile(error)) return false;
    if (error instanceof Error && "code" in error && error.code === "ERR_SQLITE_ERROR")
      return false;
    throw error;
  }
}

const hourMilliseconds = 60 * 60 * 1000;

/** Check the active snapshot without contacting the provider or taking the publisher lock. */
export async function checkOpenFoodFactsHealth(
  root: string,
  maxSourceAgeHours: number,
  now = new Date(),
) {
  const maxAge = maxSourceAgeHours * hourMilliseconds;
  if (!Number.isSafeInteger(maxAge) || maxAge <= 0)
    throw new RangeError("Invalid source age limit");

  const checkedAt = now.toISOString();
  const providerRoot = join(root, provider);
  const active = await readActiveRelease(providerRoot);
  if (!active || !(await verifyActiveArtifact(providerRoot, active.manifest))) {
    return { status: "unverified" as const, checkedAt, maxSourceAgeHours };
  }

  const { release, lastModified } = active.manifest.source;
  const age = lastModified === undefined ? null : now.getTime() - Date.parse(lastModified);
  let status: "healthy" | "stale" | "unknown-source-age" | "future-source";
  if (age === null) status = "unknown-source-age";
  else if (age < 0) status = "future-source";
  else if (age > maxAge) status = "stale";
  else status = "healthy";
  return {
    status,
    checkedAt,
    maxSourceAgeHours,
    activatedAt: active.activatedAt,
    release,
    sourceLastModified: lastModified ?? null,
    sourceAgeHours: age === null ? null : age / hourMilliseconds,
    artifactSha256: active.manifest.artifact.sha256,
  };
}

export async function refreshOpenFoodFactsCatalog(
  root: string,
  fetchExport: FetchExport = fetchHttps,
): Promise<RefreshResult> {
  return runCatalogJob(root, async (providerRoot) => {
    // Reclaim terminated downloads from both current and older workers under the job lock.
    await rm(join(providerRoot, ".refresh-source.jsonl.gz"), { force: true });
    await clearPreparedCatalogSource(root, provider);
    const upstream = await checkUpstream(fetchExport);
    const checked = new Date();
    const checkedAt = checked.toISOString();
    const sourceTime = upstream.lastModified ? Date.parse(upstream.lastModified) : null;
    if (sourceTime !== null && sourceTime > checked.getTime()) {
      throw new Error("Open Food Facts export has a future source timestamp");
    }
    const active = await readActiveRelease(providerRoot);
    const previous =
      active && (await verifyActiveArtifact(providerRoot, active.manifest)) ? active : null;
    const previousTimestamp = previous?.manifest.source.lastModified;
    const previousTime = previousTimestamp ? Date.parse(previousTimestamp) : null;
    const previousIsFuture = previousTime !== null && previousTime > checked.getTime();
    if (
      !previousIsFuture &&
      previousTime !== null &&
      sourceTime !== null &&
      sourceTime < previousTime
    ) {
      throw new Error("Open Food Facts export is older than the active release");
    }
    if (
      previous?.manifest.source.release === upstream.release &&
      previous.manifest.importerVersion === importerVersion
    ) {
      if (upstream.lastModified && (previousTime === null || previousIsFuture)) {
        const manifest = await recordCatalogSourceLastModified(
          root,
          provider,
          previous.sha256,
          upstream.lastModified,
        );
        return {
          status: "published",
          checkedAt,
          activatedAt: (await stat(join(providerRoot, "active.json"))).mtime.toISOString(),
          manifest,
        };
      }
      if (!previousIsFuture) {
        return {
          status: "unchanged",
          checkedAt,
          manifest: previous.manifest,
          activatedAt: previous.activatedAt,
        };
      }
    }

    const manifest = await publishOpenFoodFactsRelease({
      root,
      release: upstream.release,
      lastModified: upstream.lastModified,
      minimumAccepted: previous ? Math.ceil(previous.manifest.counts.accepted / 2) : undefined,
      async prepareInput(destination) {
        await downloadExport(upstream, destination, fetchExport);
        verifySource(upstream, await checkUpstream(fetchExport));
      },
    });
    return {
      status: "published",
      checkedAt,
      activatedAt: (await stat(join(providerRoot, "active.json"))).mtime.toISOString(),
      manifest,
    };
  });
}
