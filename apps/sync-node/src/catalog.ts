import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { type BarcodeLookupResult, createBarcodeLookup } from "@edo/off-import";

const offPath = "/catalog-preview/open-food-facts";
const offLicense = "https://opendatacommons.org/licenses/odbl/1-0/";
const offSource = "https://world.openfoodfacts.org/data";
const catalogLinks = {
  bls: '<https://creativecommons.org/licenses/by/4.0/>; rel="license", <https://doi.org/10.25826/Data20251217-134202-0>; rel="cite-as"',
  "open-food-facts": `<${offLicense}>; rel="license"`,
};
const resultStatuses: Record<BarcodeLookupResult["status"], number> = {
  found: 200,
  "not-found": 404,
  invalid: 400,
  "rate-limited": 429,
  unavailable: 503,
};

interface Asset {
  readonly provider: keyof typeof catalogLinks;
  readonly path: string;
  readonly type: string;
  readonly digest?: string;
}

function assetAt(path: string): Asset | null {
  const route = path.match(/^\/catalog-preview\/(bls|open-food-facts)\/(.+)$/);
  if (!route) return null;
  const [, provider, relative] = route;
  if ((provider !== "bls" && provider !== "open-food-facts") || !relative) return null;
  if (relative === "active.json") {
    return { provider, path: relative, type: "application/json" };
  }
  const match = relative.match(/^(releases|artifacts)\/([a-f0-9]{64})\.(json|sqlite)$/);
  if (!match) return null;
  const [, folder, digest, ext] = match;
  if (!digest || (folder === "releases" ? ext !== "json" : ext !== "sqlite")) return null;
  return {
    provider,
    path: relative,
    type: ext === "json" ? "application/json" : "application/vnd.sqlite3",
    digest,
  };
}

async function serveAsset(
  root: string,
  asset: Asset,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const etag = asset.digest ? `"${asset.digest}"` : undefined;
  try {
    await using file = await open(
      join(root, asset.provider, asset.path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      response.writeHead(404).end();
      return;
    }
    if (asset.digest) {
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) {
        hash.update(chunk);
      }
      if (hash.digest("hex") !== asset.digest) {
        response.writeHead(503).end();
        return;
      }
    }
    const headers = {
      "Content-Type": asset.type,
      "Cache-Control": asset.digest ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      Link: catalogLinks[asset.provider],
      ...(etag && { ETag: etag }),
    };
    if (etag && request.headers["if-none-match"] === etag) {
      response.writeHead(304, headers).end();
      return;
    }
    response.writeHead(200, { ...headers, "Content-Length": metadata.size });
    if (request.method === "HEAD") response.end();
    else await pipeline(file.createReadStream({ autoClose: false, start: 0 }), response);
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    response.writeHead(code === "ENOENT" || code === "ELOOP" ? 404 : 503).end();
  }
}

/** Development-only routes for public food data. Private records are outside this handler. */
export function catalogPreview(root: string, live: boolean) {
  const lookup = createBarcodeLookup(root, live ? {} : { liveLookup: null });
  return {
    async handle(request: IncomingMessage, response: ServerResponse) {
      const path = request.url?.split("?", 1)[0] ?? "/";
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(404).end();
        return;
      }
      const asset = assetAt(path);
      if (asset) {
        await serveAsset(root, asset, request, response);
        return;
      }
      const barcodePath = `${offPath}/barcodes/`;
      if (request.method !== "GET" || !path.startsWith(barcodePath)) {
        response.writeHead(404).end();
        return;
      }
      const barcode = path.slice(barcodePath.length);
      const result: BarcodeLookupResult = /^\d{4,64}$/.test(barcode)
        ? await lookup.lookupBarcode(barcode)
        : { status: "invalid" };
      response.writeHead(resultStatuses[result.status], {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(
        JSON.stringify({
          ...result,
          attribution: {
            name: "Open Food Facts contributors",
            license: offLicense,
            source: offSource,
            ...(result.status === "found" &&
              result.source === "catalog" && {
                catalog: `${offPath}/releases/${result.releaseManifestSha256}.json`,
              }),
          },
        }),
      );
    },
    close: () => lookup[Symbol.dispose](),
  };
}
