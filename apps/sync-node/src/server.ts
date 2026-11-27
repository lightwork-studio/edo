import { createServer } from "node:http";
import { serveCatalogAssets } from "./catalog-assets.ts";
import { createOpenFoodFactsPreview } from "./open-food-facts-preview.ts";

export function createHealthServer({
  catalogRoot,
  liveOpenFoodFacts = false,
}: {
  catalogRoot?: string;
  liveOpenFoodFacts?: boolean;
} = {}) {
  const off = catalogRoot ? createOpenFoodFactsPreview(catalogRoot, liveOpenFoodFacts) : null;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (catalogRoot && (await serveCatalogAssets(catalogRoot, request, response))) return;
    if (off && (await off.serveBarcode(request, response))) return;
    response.writeHead(404).end();
  });
  server.once("close", () => off?.close());
  return server;
}
