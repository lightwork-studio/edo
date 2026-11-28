import { readFileSync, writeFileSync } from "node:fs";
import { installSyncJournal } from "../../packages/sync/src/journal-schema-v7.ts";

const fixtures = new URL("../../packages/storage/test/fixtures/", import.meta.url);
const diarySql = readFileSync(new URL("diary-v4.sql", fixtures), "utf8");
const archive = JSON.parse(readFileSync(new URL("diary-v4-archive.json", fixtures), "utf8"));
const meal = archive.meals[0];
if (!meal?.id) throw new Error("The diary fixture has no meal");
const key = { kind: "meal", id: meal.id };
const attempt = {
  ...key,
  submissionId: "v7-native-attempt",
  baseRevision: 7,
  op: "put",
  content: meal,
};
const outbox = {
  key,
  baseRevision: 7,
  base: null,
  pending: null,
  attempt,
  blocked: null,
};
const claim = JSON.stringify(meal.items.map(({ id }) => id));
const statements = [diarySql];
installSyncJournal({ exec: (statement) => statements.push(statement) });
function sqlText(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
statements.push(`
  INSERT INTO edo_sync_binding
  VALUES (1, 'https://example.test', 'fixture-account', 'fixture-lineage', 7, 3);
  INSERT INTO edo_sync_outbox
  VALUES ('meal', ${sqlText(meal.id)}, 'v7-native-attempt', '0.1', ${sqlText(JSON.stringify(outbox))});
  INSERT INTO edo_sync_submission_ids VALUES ('v7-native-attempt'), ('v7-native-prior');
  INSERT INTO edo_sync_receipts VALUES ('v7-native-prior');
  INSERT INTO edo_sync_meal_projections
  VALUES (${sqlText(meal.id)}, 6, 'accepted', ${sqlText(JSON.stringify(meal))});
  INSERT INTO edo_sync_staged_meal_claims VALUES (${sqlText(meal.id)}, ${sqlText(claim)}, 1);
  PRAGMA user_version = 7;
`);
const fixture = [
  `export const fixtureSql = ${JSON.stringify(statements.join("\n"))};`,
  `export const expectedArchive: unknown = ${JSON.stringify(archive)};`,
  `export const expectedMealId = ${JSON.stringify(meal.id)};`,
  `export const expectedClaim = ${JSON.stringify(claim)};`,
  `export const expectedPriorMeal = ${JSON.stringify(JSON.stringify(meal))};`,
  `export const expectedAttempt: unknown = ${JSON.stringify(attempt)};`,
].join("\n");
writeFileSync(new URL("../../apps/mobile/verify/diary-v7-data.ts", import.meta.url), fixture);
