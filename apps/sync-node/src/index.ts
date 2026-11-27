import { createHealthServer } from "./server.ts";

createHealthServer({
  catalogRoot: process.env.EDO_CATALOG_ROOT,
  liveOpenFoodFacts: process.env.EDO_LIVE_OPEN_FOOD_FACTS === "1",
}).listen(8787, "127.0.0.1", () => {
  console.log("Edo development server at http://127.0.0.1:8787/health");
});
