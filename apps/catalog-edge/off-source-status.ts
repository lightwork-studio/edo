import { compatibleOpenFoodFactsManifest } from "../../packages/off-import/src/manifest.ts";
import { maxManifestBytes, maxOffSourceAgeMilliseconds } from "./state.ts";

function freshness(age: number | null) {
  if (age === null) return "missing-source-time";
  if (age < 0) return "future-source-time";
  return age >= maxOffSourceAgeMilliseconds ? "stale" : "fresh";
}

/** Describe the source age of a published manifest without inferring when it was activated. */
export function inspectOffSource(value: unknown, now: number) {
  const manifest = compatibleOpenFoodFactsManifest(value);
  if (!manifest) throw new Error("Invalid Open Food Facts manifest");
  const sourceLastModified = manifest.source.lastModified ?? null;
  const age = sourceLastModified === null ? null : now - Date.parse(sourceLastModified);
  return {
    status: freshness(age),
    release: manifest.source.release,
    artifactSha256: manifest.artifact.sha256,
    acceptedRows: manifest.counts.accepted,
    observedAt: new Date(now).toISOString(),
    sourceLastModified,
    sourceAgeSeconds: age === null ? null : Math.floor(age / 1000),
    maxSourceAgeSeconds: maxOffSourceAgeMilliseconds / 1000,
  };
}

async function readManifest(input: AsyncIterable<Buffer>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of input) {
    length += chunk.byteLength;
    if (length > maxManifestBytes) throw new Error("Open Food Facts manifest is oversized");
    chunks.push(chunk);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return JSON.parse(decoder.decode(Buffer.concat(chunks, length))) as unknown;
}

if (import.meta.main) {
  try {
    const report = inspectOffSource(await readManifest(process.stdin), Date.now());
    console.log(JSON.stringify(report));
    if (report.status !== "fresh") process.exitCode = 1;
  } catch {
    console.error("Could not read a valid Open Food Facts manifest from standard input.");
    process.exitCode = 1;
  }
}
