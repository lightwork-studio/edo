import { readFileSync, writeFileSync } from "node:fs";

const fixtures = new URL("../../packages/storage/test/fixtures/", import.meta.url);
const sql = readFileSync(new URL("diary-v4.sql", fixtures), "utf8");
const archive = readFileSync(new URL("diary-v4-archive.json", fixtures), "utf8");
const target = new URL("../../apps/mobile/verify/diary-v4-data.ts", import.meta.url);
const fixture = `export const fixtureSql = ${JSON.stringify(sql)};\nexport const expectedArchive: unknown = ${JSON.stringify(JSON.parse(archive))};\n`;
writeFileSync(target, fixture);
