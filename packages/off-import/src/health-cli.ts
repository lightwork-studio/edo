import { checkOpenFoodFactsHealth } from "./refresh.ts";

const [root, age] = process.argv.slice(2);
const maxAge = Number(age);
if (!root || process.argv.length !== 4 || !Number.isFinite(maxAge) || maxAge <= 0) {
  console.error(
    "Usage: pnpm --filter @edo/off-import run health <output-dir> <max-source-age-hours>",
  );
  process.exitCode = 2;
} else {
  try {
    const result = await checkOpenFoodFactsHealth(root, maxAge);
    console.log(JSON.stringify(result));
    process.exitCode = result.status === "healthy" ? 0 : 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 2;
  }
}
