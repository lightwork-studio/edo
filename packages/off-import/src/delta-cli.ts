import { refreshOpenFoodFactsDeltas } from "./delta.ts";

const [root, from, ...extra] = process.argv.slice(2);
if (!root || extra.length || (from && !/^\d{1,10}$/.test(from))) {
  console.error(
    "Usage: pnpm --filter @edo/off-import run delta <output-dir> [bootstrap-unix-seconds]",
  );
  process.exitCode = 1;
} else {
  try {
    const result = await refreshOpenFoodFactsDeltas(root, {
      bootstrapFrom: from === undefined ? undefined : Number(from),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
