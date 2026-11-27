import { createServer } from "node:http";
import { serveBlsPreview } from "./bls-preview.ts";

export function createHealthServer({ catalogRoot }: { catalogRoot?: string } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (catalogRoot && (await serveBlsPreview(catalogRoot, request, response))) return;
    response.writeHead(404).end();
  });
}
