import { createHealthServer } from "./server.ts";

createHealthServer().listen(8787, "127.0.0.1", () => {
  console.log("Edo development server at http://127.0.0.1:8787/health");
});
