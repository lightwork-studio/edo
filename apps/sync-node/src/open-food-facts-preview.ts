import type { IncomingMessage, ServerResponse } from "node:http";
import { type BarcodeLookupResult, createBarcodeLookup } from "@edo/off-import";
import { openFoodFactsAttribution } from "./catalog-assets.ts";

const prefix = "/catalog-preview/open-food-facts";
const barcodePath = `${prefix}/barcodes/`;
const statuses: Record<BarcodeLookupResult["status"], number> = {
  found: 200,
  "not-found": 404,
  invalid: 400,
  "rate-limited": 429,
  unavailable: 503,
};

export function createOpenFoodFactsPreview(root: string, useLiveLookup: boolean) {
  const lookup = createBarcodeLookup(root, useLiveLookup ? {} : { liveLookup: null });
  let servedCatalogRelease: string | undefined;
  return {
    servedRelease: () => servedCatalogRelease,
    async serveBarcode(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const path = request.url?.split("?", 1)[0] ?? "";
      if (request.method !== "GET" || !path.startsWith(barcodePath)) return false;
      const code = path.slice(barcodePath.length);
      const result: BarcodeLookupResult = /^\d{4,64}$/.test(code)
        ? await lookup.lookupBarcode(code)
        : { status: "invalid" };
      if (result.status === "found" && result.source === "catalog") {
        servedCatalogRelease = result.releaseManifestSha256;
      }
      const body = JSON.stringify({
        ...result,
        attribution: {
          ...openFoodFactsAttribution,
          ...(result.status === "found" &&
            result.source === "catalog" && {
              catalog: `${prefix}/releases/${result.releaseManifestSha256}.json`,
            }),
        },
      });
      response.writeHead(statuses[result.status], {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(body),
      });
      response.end(body);
      return true;
    },
    close: () => lookup[Symbol.dispose](),
  };
}
