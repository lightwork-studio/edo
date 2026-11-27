import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { deserializeDatabaseAsync } from "expo-sqlite";
import { httpsOrigin } from "./catalog-origin";
import { blsSeedAsset } from "./catalog-seed";

const previewOrigin = httpsOrigin(process.env.EXPO_PUBLIC_EDO_BLS_PREVIEW_ORIGIN);
const previewDigest = process.env.EXPO_PUBLIC_EDO_BLS_PREVIEW_SHA256;
const previewConfig =
  previewOrigin && previewDigest?.length === 64 && /^[a-f0-9]+$/.test(previewDigest)
    ? { origin: previewOrigin, digest: previewDigest }
    : null;

export async function openLocalCatalog() {
  const preview = previewConfig ? await import("./bls-preview-update").catch(() => null) : null;
  if (preview && previewConfig) {
    const cached = await preview.openBlsPreview(previewConfig);
    if (cached) return cached;
  }
  const bundled = await openBundledCatalog();
  if (preview && previewConfig) void preview.refreshBlsPreview(previewConfig);
  return bundled;
}

async function openBundledCatalog() {
  const [asset] = await Asset.loadAsync(blsSeedAsset);
  if (!asset?.localUri) throw new Error("Missing bundled BLS catalog");

  // The bundled public catalog is small enough to open in memory, separate from the diary file.
  const bytes = await new File(asset.localUri).bytes();
  const db = await deserializeDatabaseAsync(bytes);
  try {
    await db.execAsync("PRAGMA query_only = ON");
    const metadata = await db.getFirstAsync<{ release: string }>(
      "SELECT release FROM catalog_metadata WHERE singleton = 1 AND provider = 'bls'",
    );
    if (metadata?.release !== "4.0-2025") throw new Error("Unexpected BLS catalog release");
    return { db, close: () => db.closeAsync() };
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}
