import { publishOpenFoodFactsCatalog } from "./index.ts";

const [inputPath, release, root] = process.argv.slice(2);
if (!inputPath || !release || !root || process.argv.length !== 5) {
  console.error(
    "Usage: pnpm --filter @edo/off-import run import <export.jsonl.gz> <release> <output-dir>",
  );
  process.exitCode = 1;
} else {
  const manifest = await publishOpenFoodFactsCatalog({ inputPath, release, root });
  console.log(JSON.stringify(manifest, null, 2));
}
