import { restoreOpenFoodFactsRelease } from "./publish.ts";

const [root, releaseSha256] = process.argv.slice(2);
if (!root || !releaseSha256 || process.argv.length !== 4) {
  console.error(
    "Usage: pnpm --filter @edo/off-import run restore <catalog-root> <manifest-sha256>",
  );
  process.exitCode = 1;
} else {
  const manifest = await restoreOpenFoodFactsRelease(root, releaseSha256);
  console.log(JSON.stringify(manifest, null, 2));
}
