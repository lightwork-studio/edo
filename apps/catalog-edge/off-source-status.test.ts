import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  openFoodFactsCatalog,
  openFoodFactsNotice,
} from "../../packages/off-import/src/manifest.ts";
import { inspectOffSource } from "./off-source-status.ts";
import { maxManifestBytes } from "./state.ts";

const checkpoint = "2026-11-27T04:00:00.000Z";
const ageLimit = 72 * 60 * 60 * 1000;
const manifest = {
  manifestVersion: 1,
  provider: "open-food-facts",
  schemaVersion: 1,
  importerVersion: "fixture",
  source: {
    release: "off-delta-v1-fixture",
    url: openFoodFactsCatalog.deltaIndexUrl,
    sha256: "a".repeat(64),
    lastModified: checkpoint,
  },
  attribution: {
    name: openFoodFactsNotice.name,
    license: openFoodFactsNotice.license,
    changes: openFoodFactsNotice.changes,
  },
  artifact: { bytes: 1_024, sha256: "b".repeat(64) },
  counts: { accepted: 428_065, rejected: 0 },
};

test("reports the source age against the nightly freshness bound", () => {
  const time = Date.parse(checkpoint);
  const now = time + ageLimit - 1;
  expect(inspectOffSource(manifest, now)).toEqual({
    status: "fresh",
    release: manifest.source.release,
    artifactSha256: manifest.artifact.sha256,
    acceptedRows: manifest.counts.accepted,
    observedAt: new Date(now).toISOString(),
    sourceLastModified: checkpoint,
    sourceAgeSeconds: 259_199,
    maxSourceAgeSeconds: 259_200,
  });
  expect(inspectOffSource(manifest, time + ageLimit).status).toBe("stale");
});

test("distinguishes a missing or future source date from a valid recent refresh", () => {
  const time = Date.parse(checkpoint);
  expect(inspectOffSource(manifest, time - 1)).toMatchObject({
    status: "future-source-time",
    sourceAgeSeconds: -1,
  });
  expect(
    inspectOffSource(
      { ...manifest, source: { ...manifest.source, lastModified: undefined } },
      time,
    ),
  ).toMatchObject({
    status: "missing-source-time",
    sourceLastModified: null,
    sourceAgeSeconds: null,
  });
  expect(() => inspectOffSource({ ...manifest, provider: "bls" }, time)).toThrow("Invalid");
  expect(() =>
    inspectOffSource(
      { ...manifest, source: { ...manifest.source, lastModified: "yesterday" } },
      time,
    ),
  ).toThrow("Invalid");
});

test("requires a schema, source and attribution supported by the publisher", () => {
  const time = Date.parse(checkpoint);
  for (const invalid of [
    { ...manifest, schemaVersion: openFoodFactsCatalog.schemaVersion + 1 },
    { ...manifest, source: { ...manifest.source, url: "https://example.test/catalog" } },
    { ...manifest, attribution: { ...manifest.attribution, license: "CC0" } },
  ]) {
    expect(() => inspectOffSource(invalid, time)).toThrow("Invalid");
  }
});

test("the standard-input command reports stale data and rejects an oversized manifest", () => {
  const command = fileURLToPath(new URL("./off-source-status.ts", import.meta.url));
  const oldManifest = {
    ...manifest,
    source: { ...manifest.source, lastModified: "2000-01-01T00:00:00.000Z" },
  };
  const stale = spawnSync(process.execPath, [command], {
    input: JSON.stringify(oldManifest),
    encoding: "utf8",
  });
  expect(stale.status).toBe(1);
  expect(JSON.parse(stale.stdout)).toMatchObject({ status: "stale" });

  const oversized = spawnSync(process.execPath, [command], {
    input: " ".repeat(maxManifestBytes) + JSON.stringify(manifest),
    encoding: "utf8",
  });
  expect(oversized.status).toBe(1);
  expect(oversized.stdout).toBe("");
  expect(oversized.stderr).toContain("valid Open Food Facts manifest");
});
