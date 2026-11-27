import { isCatalogProvider, restoreCatalogRelease } from "./index.ts";

const [root, provider, releaseSha256] = process.argv.slice(2);
if (!root || !isCatalogProvider(provider) || !releaseSha256 || process.argv.length !== 5) {
  console.error(
    "Usage: pnpm --filter @edo/catalog-import run restore <catalog-root> <provider> <manifest-sha256>",
  );
  process.exitCode = 1;
} else {
  const manifest = await restoreCatalogRelease(root, provider, releaseSha256);
  console.log(JSON.stringify(manifest, null, 2));
}
