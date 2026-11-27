import { createServer } from "node:http";
import { catalogPreview } from "./catalog.ts";

export function createHealthServer(
  options: { catalogRoot?: string; liveOpenFoodFacts?: boolean } = {},
) {
  const catalog = options.catalogRoot
    ? catalogPreview(options.catalogRoot, options.liveOpenFoodFacts ?? false)
    : null;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (catalog) {
      void catalog.handle(request, response).catch(() => {
        if (response.headersSent) response.destroy();
        else response.writeHead(503).end();
      });
    } else {
      response.writeHead(404).end();
    }
  });
  if (catalog) server.on("close", catalog.close);
  return server;
}
