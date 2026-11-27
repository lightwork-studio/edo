import { compatibleCatalog } from "@edo/catalog-import/manifest";
import { fetch } from "expo/fetch";
import { CryptoDigestAlgorithm, digest as digestBytes } from "expo-crypto";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { deserializeDatabaseAsync } from "expo-sqlite";
import { searchBls } from "./catalog";

const provider = "bls";
const release = "4.0-2025";
const schema = 1;
const sourceUrl = "https://doi.org/10.25826/Data20251217-134202-0";
const sourceSha256 = "12b7a6ba62807ec9b301eb276f897dc85f99b2292311618dec3749a12d984c91";
const bundleSha256 = "de019d3c43f8836e678d6eb32584ba1280fc2b0fe9c2ee6fb033af73c17cdf05";
const attribution = "Max Rubner-Institut (2025), Bundeslebensmittelschlüssel (BLS), Version 4.0";
const licenseUrl = "https://creativecommons.org/licenses/by/4.0/";
const foodCount = 7140;
const maxManifestBytes = 16 * 1024;
const maxArtifactBytes = 8 * 1024 * 1024;
const requestTimeoutMs = 15_000;
const cacheDirectoryName = "edo-bls-preview";
const stagedName = "pending.sqlite";

interface PreviewConfig {
  origin: string;
  digest: string;
}

function eligibleManifest(value: unknown, digest: string) {
  const manifest = compatibleCatalog(value, provider, [schema]);
  if (
    !manifest ||
    manifest.source.release !== release ||
    manifest.source.url !== sourceUrl ||
    manifest.source.sha256 !== sourceSha256 ||
    manifest.attribution.name !== attribution ||
    manifest.attribution.license !== `CC BY 4.0 (${licenseUrl})` ||
    manifest.counts.accepted !== foodCount ||
    manifest.counts.rejected !== 0 ||
    (manifest.counts.skipped ?? 0) !== 0 ||
    manifest.artifact.sha256 !== digest ||
    manifest.artifact.bytes > maxArtifactBytes
  ) {
    return null;
  }
  return manifest;
}

async function readBounded(
  url: string,
  contentType: string,
  limit: number,
  exact = false,
): Promise<Uint8Array<ArrayBuffer>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      credentials: "omit",
      redirect: "error",
      headers: { Accept: contentType, "Accept-Encoding": "identity" },
      signal: controller.signal,
    });
    const length = response.headers.get("content-length");
    const encoding = response.headers.get("content-encoding");
    const expected = Number(length);
    if (
      response.status !== 200 ||
      response.redirected ||
      (response.url && response.url !== url) ||
      (encoding !== null && encoding.toLowerCase() !== "identity") ||
      length === null ||
      !/^\d+$/.test(length) ||
      expected < 1 ||
      expected > limit ||
      (exact && expected !== limit)
    ) {
      throw new Error("Invalid BLS preview response");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing BLS preview response body");
    try {
      const bytes = new Uint8Array(expected);
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > expected - received) throw new Error("BLS preview exceeds length");
        bytes.set(value, received);
        received += value.byteLength;
      }
      if (received !== expected) throw new Error("Incomplete BLS preview response");
      return bytes;
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function readApprovedBytes(
  file: File,
  expected: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const handle = file.open(FileMode.ReadOnly);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const size = handle.size;
    if (!size || size > maxArtifactBytes) return null;
    bytes = await handle.readBytes(size + 1);
    if (bytes.byteLength !== size) return null;
  } finally {
    handle.close();
  }
  const checksum = new Uint8Array(await digestBytes(CryptoDigestAlgorithm.SHA256, bytes));
  const hex = Array.from(checksum, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex === expected ? bytes : null;
}

async function openCheckedCatalog(file: File, digest: string) {
  const bytes = await readApprovedBytes(file, digest);
  if (!bytes) throw new Error("BLS preview checksum mismatch");
  const db = await deserializeDatabaseAsync(bytes);
  try {
    await db.execAsync("PRAGMA trusted_schema = OFF; PRAGMA query_only = ON");
    const version = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
    const integrity = await db.getFirstAsync<{ quick_check: string }>("PRAGMA quick_check(1)");
    const metadata = await db.getFirstAsync<{
      provider: string;
      release: string;
      source_url: string;
      attribution: string;
      license_url: string;
      count: number;
    }>(`SELECT provider, release, source_url, attribution, license_url,
              (SELECT count(*) FROM food) AS count FROM catalog_metadata WHERE singleton = 1`);
    if (
      version?.user_version !== schema ||
      integrity?.quick_check !== "ok" ||
      metadata?.provider !== provider ||
      metadata.release !== release ||
      metadata.source_url !== sourceUrl ||
      metadata.attribution !== attribution ||
      metadata.license_url !== licenseUrl ||
      metadata.count !== foodCount ||
      (await searchBls(db, "Banane", "de")).length === 0
    ) {
      throw new Error("Incompatible BLS preview catalog");
    }
    return { db, close: () => db.closeAsync() };
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}

export async function openBlsPreview({ digest }: PreviewConfig) {
  if (digest === bundleSha256) return null;
  try {
    const file = new File(Paths.cache, cacheDirectoryName, `${digest}.sqlite`);
    return file.exists ? await openCheckedCatalog(file, digest) : null;
  } catch {
    return null;
  }
}

async function installPreview({ origin, digest }: PreviewConfig) {
  if (digest === bundleSha256) return;
  const directory = new Directory(Paths.cache, cacheDirectoryName);
  const installedName = `${digest}.sqlite`;
  const installed = new File(directory, installedName);
  const staged = new File(directory, stagedName);
  if (staged.exists) staged.delete();
  if (installed.exists && (await readApprovedBytes(installed, digest))) return;

  const endpoint = `${origin}/catalog-preview/bls`;
  const manifestBytes = await readBounded(
    `${endpoint}/active.json`,
    "application/json",
    maxManifestBytes,
  );
  const manifest = eligibleManifest(JSON.parse(new TextDecoder().decode(manifestBytes)), digest);
  if (!manifest) return;

  const artifact = await readBounded(
    `${endpoint}/artifacts/${installedName}`,
    "application/vnd.sqlite3",
    manifest.artifact.bytes,
    true,
  );
  directory.create({ idempotent: true, intermediates: true });
  try {
    staged.create({ overwrite: false });
    await staged.write(artifact);
    const checked = await openCheckedCatalog(staged, digest);
    await checked.close();
    if (installed.exists) installed.delete();
    await staged.move(installed, { overwrite: false });
    for (const entry of directory.list()) {
      if (
        entry instanceof File &&
        /^[a-f0-9]{64}\.sqlite$/.test(entry.name) &&
        entry.name !== installedName
      ) {
        entry.delete();
      }
    }
  } finally {
    // Moving a File changes its URI. Only remove the fixed staging path.
    const incomplete = new File(directory, stagedName);
    if (incomplete.exists) incomplete.delete();
  }
}

let currentRefresh: Promise<void> | undefined;

export function refreshBlsPreview(config: PreviewConfig) {
  currentRefresh ??= installPreview(config)
    .catch(() => {
      // Preview failure leaves the bundled catalog available in this session and on reopen.
    })
    .finally(() => {
      currentRefresh = undefined;
    });
  return currentRefresh;
}
