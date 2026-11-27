import { refreshOpenFoodFactsCatalog } from "./refresh.ts";

const [root] = process.argv.slice(2);
if (!root || process.argv.length !== 3) {
  console.error("Usage: pnpm --filter @edo/off-import run refresh <output-dir>");
  process.exitCode = 1;
} else {
  try {
    const result = await refreshOpenFoodFactsCatalog(root);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
