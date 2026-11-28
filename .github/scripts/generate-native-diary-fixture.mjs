import { readFileSync, writeFileSync } from "node:fs";
import { installSyncJournal } from "../../packages/sync/src/journal-schema-v9.ts";

const fixtures = new URL("../../packages/storage/test/fixtures/", import.meta.url);
const diarySql = readFileSync(new URL("diary-v4.sql", fixtures), "utf8");
const archive = JSON.parse(readFileSync(new URL("diary-v4-archive.json", fixtures), "utf8"));
const meal = archive.meals[0];
const weighIn = archive.weighIns[0];
if (!meal?.id || !weighIn?.id) throw new Error("The diary fixture is incomplete");
const key = { kind: "meal", id: meal.id };
const remote = { ...key, revision: 8, state: "live", content: { ...meal, future: "server-only" } };
const observed = { ...remote, revision: 7, content: { ...meal, future: "previous" } };
const attempt = {
  ...key,
  submissionId: "v9-native-attempt",
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
  VALUES (1, 'https://example.test', 'fixture-account', 'fixture-lineage', 8, 8);
  INSERT INTO edo_sync_outbox
  VALUES ('meal', ${sqlText(meal.id)}, 'v9-native-attempt', '0.1', ${sqlText(JSON.stringify(outbox))});
  INSERT INTO edo_sync_submission_ids VALUES ('v9-native-attempt'), ('v9-native-prior');
  INSERT INTO edo_sync_receipts VALUES ('v9-native-prior');
  INSERT INTO edo_sync_meal_projections
  VALUES (${sqlText(meal.id)}, 6, 'accepted', ${sqlText(JSON.stringify(meal))});
  INSERT INTO edo_sync_weigh_in_projections
  VALUES (${sqlText(weighIn.id)}, 5, ${sqlText(JSON.stringify(weighIn))});
  INSERT INTO edo_sync_remote
  VALUES ('meal', ${sqlText(meal.id)}, 8, ${sqlText(JSON.stringify(remote))});
  INSERT INTO edo_sync_staged_meal_claims VALUES (${sqlText(meal.id)}, ${sqlText(claim)}, 1);
  INSERT INTO edo_sync_attempt_observations
  VALUES ('v9-native-attempt', 7, ${sqlText(JSON.stringify(observed))});
  PRAGMA user_version = 9;
`);
const fixture = [
  `export const fixtureSql = ${JSON.stringify(statements.join("\n"))};`,
  `export const expectedArchive: unknown = ${JSON.stringify(archive)};`,
  `export const expectedMealId = ${JSON.stringify(meal.id)};`,
  `export const expectedClaim = ${JSON.stringify(claim)};`,
  `export const expectedPriorMeal = ${JSON.stringify(JSON.stringify(meal))};`,
  `export const expectedWeighIn: unknown = ${JSON.stringify({
    id: weighIn.id,
    revision: 5,
    content: JSON.stringify(weighIn),
  })};`,
  `export const expectedRemote: unknown = ${JSON.stringify(remote)};`,
  `export const expectedObservation = ${JSON.stringify(
    JSON.stringify({
      submission_id: attempt.submissionId,
      revision: observed.revision,
      content: JSON.stringify(observed),
    }),
  )};`,
  `export const expectedAttempt: unknown = ${JSON.stringify(attempt)};`,
].join("\n");
writeFileSync(new URL("../../apps/mobile/verify/diary-v9-data.ts", import.meta.url), fixture);
