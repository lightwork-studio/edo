import { createServer } from "node:http";
import { serveCatalogAssets } from "./catalog-assets.ts";
import { createOpenFoodFactsPreview } from "./open-food-facts-preview.ts";
import { type SyncHttpOptions, syncHttp } from "./sync-http.ts";

export function createHealthServer({
  catalogRoot,
  liveOpenFoodFacts = false,
  sync: syncOptions,
}: {
  catalogRoot?: string;
  liveOpenFoodFacts?: boolean;
  sync?: SyncHttpOptions;
} = {}) {
  const off = catalogRoot ? createOpenFoodFactsPreview(catalogRoot, liveOpenFoodFacts) : null;
  const sync = syncOptions ? syncHttp(syncOptions) : null;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    try {
      if ((request.method === "GET" || request.method === "HEAD") && request.url === "/ready") {
        const ready = syncOptions?.store.isReady() ?? false;
        response.writeHead(ready ? 200 : 503, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(
          request.method === "HEAD"
            ? undefined
            : JSON.stringify({ status: ready ? "ready" : "unavailable" }),
        );
        return;
      }
      if (sync && (await sync(request, response))) return;
      if (
        catalogRoot &&
        (await serveCatalogAssets(catalogRoot, request, response, off?.servedRelease()))
      ) {
        return;
      }
      if (off && (await off.serveBarcode(request, response))) return;
      response.writeHead(404).end();
    } catch {
      if (response.headersSent) response.destroy();
      else response.writeHead(503).end();
    }
  });
  server.once("close", () => off?.close());
  return server;
}
