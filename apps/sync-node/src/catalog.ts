import type { IncomingMessage, ServerResponse } from "node:http";
import { type BarcodeLookupResult, createBarcodeLookup } from "@edo/off-import";
import { offLicense, serveCatalogAsset } from "./catalog-assets.ts";

const offPath = "/catalog-preview/open-food-facts";
const offSource = "https://world.openfoodfacts.org/data";
const resultStatuses: Record<BarcodeLookupResult["status"], number> = {
  found: 200,
  "not-found": 404,
  invalid: 400,
  "rate-limited": 429,
  unavailable: 503,
};

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
      if (await serveCatalogAsset(root, path, request, response)) return;
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
