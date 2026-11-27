import { createHealthServer } from "./server.ts";

const server = createHealthServer({
  catalogRoot: process.env.EDO_CATALOG_ROOT,
  liveOpenFoodFacts: process.env.EDO_LIVE_OPEN_FOOD_FACTS === "1",
}).listen(8787, "127.0.0.1", () => {
  console.log("Edo development server at http://127.0.0.1:8787/health");
});

function stop() {
  server.close();
  server.closeAllConnections();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
server.once("close", () => {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
});
