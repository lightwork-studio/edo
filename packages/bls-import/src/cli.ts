import { publishBlsCatalog } from "./publish.ts";

const [archive, root, extra] = process.argv.slice(2);
if (!archive || !root || extra !== undefined) {
  throw new Error("Usage: pnpm --filter @edo/bls-import run import <release.zip> <catalog-root>");
}

const manifest = await publishBlsCatalog(archive, root);
console.log(JSON.stringify(manifest, null, 2));
